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
import { DevConsole } from "../src/console.js";

const coreRegistry = new ComponentRegistry();
registerCoreComponents(coreRegistry);

const EMITTERS = ["weather-rain", "weather-snow", "weather-sand", "weather-dust"];

/** A scene with a day/night + weather world, and a console pointed at it. */
function world(options: { authority?: boolean } = {}) {
  const ops: Op[] = [
    {
      op: "add-entity",
      id: "sky",
      entity: {
        name: "Sky",
        parent: null,
        tags: [],
        components: { script: { name: "day-night", params: { dayLength: 7200, startHour: 9 } } },
      },
    },
    {
      op: "add-entity",
      id: "world",
      entity: {
        name: "World",
        parent: null,
        tags: [],
        components: { script: { name: "weather", params: { force: "clear" } } },
      },
    },
  ];
  for (const tag of EMITTERS) {
    ops.push({ op: "add-entity", id: tag, entity: { name: tag, parent: null, tags: [tag], components: { transform: {} } } } as Op);
  }
  const doc: SceneDoc = applyOps(createScene("t"), ops, coreRegistry).doc;
  const objects = new Map<string, THREE.Object3D>();
  for (const id of ["sky", "world", ...EMITTERS]) objects.set(id, new THREE.Object3D());
  const sky: LiveSkyOptions[] = [];
  const registry = new ScriptRegistry();
  registerBuiltinScripts(registry);
  const runtime = new ScriptRuntime({
    doc,
    objects,
    registry,
    sim: { getLinvel: () => [0, 0, 0], setLinvel: () => {}, applyImpulse: () => {} },
    input: { isDown: () => false },
    setSky: (opts) => sky.push(opts),
    setParticles: () => {},
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
  runtime.start();
  const dev = new DevConsole({
    runtime: () => runtime,
    isAuthority: () => options.authority ?? true,
  });
  const tick = (seconds: number) => {
    for (let i = 0; i < seconds * 30; i++) runtime.fixedUpdate(1 / 30);
  };
  const say = (line: string) => dev.run(line).map((l) => `${l.kind}:${l.text}`).join("\n");
  // Two scripts write the sky; `last` alone would hand back whichever of
  // them wrote most recently, and the weather layer carries no sun.
  const lastWith = <K extends keyof LiveSkyOptions>(key: K) => {
    for (let i = sky.length - 1; i >= 0; i--) if (sky[i]![key] !== undefined) return sky[i]!;
    throw new Error(`no sky write carried ${String(key)}`);
  };
  return { runtime, dev, sky, tick, say, objects, last: () => sky[sky.length - 1]!, lastWith };
}

/**
 * The weather rolls dice — how long a front lasts, when lightning strikes —
 * so these run on a SEEDED random. Without it the sample points below land at
 * different places on the envelope each run, and the suite fails a few percent
 * of the time, which teaches everyone to re-run it instead of reading it.
 */
let entropy = 0;
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

describe("developer console", () => {
  it("publishes the actual offline clock for HUDs, including console changes and freeze", () => {
    const { objects, say, tick, runtime } = world();
    const hour = () => objects.get("sky")!.userData["dayNightHour"] as number;
    expect(hour()).toBe(9);
    tick(1); expect(hour()).toBeGreaterThan(9);
    say("/time 23:45"); expect(hour()).toBe(23.75);
    say("/time freeze"); tick(1); expect(hour()).toBe(23.75);
    say("/time resume"); tick(1); expect(hour()).toBeGreaterThan(23.75);
    runtime.dispose();
  });
  it("lists only the commands the live scripts actually declare", () => {
    const { dev } = world();
    const names = dev.commands().map((c) => c.name);
    expect(names).toContain("time");
    expect(names).toContain("weather");
    expect(names).toContain("help");
    // /help is generated from the declarations, so a command can never ship
    // documented-but-absent or present-but-undocumented
    const help = dev.run("/help")[0]!.text;
    for (const name of names) expect(help).toContain(`/${name}`);
  });

  it("refuses an unknown command by name rather than doing nothing", () => {
    const { say } = world();
    expect(say("/nope")).toMatch(/unknown command \/nope/);
  });

  it("sets the clock, and the sky follows in the same tick", () => {
    const { say, lastWith, tick } = world();
    tick(0.2);
    const noonSun = lastWith("sun").sun!.intensity!;
    expect(say("/time midnight")).toContain("00:00");
    expect(lastWith("sun").sun!.intensity!).toBeLessThan(noonSun * 0.5); // it is actually dark now
    expect(say("/time")).toMatch(/00:0\d · night/);
    expect(say("/time noon")).toContain("12:00");
    expect(lastWith("sun").sun!.intensity!).toBeGreaterThan(noonSun * 0.5);
  });

  it("freezes and resumes the clock", () => {
    const { say, tick } = world();
    say("/time 12");
    say("/time freeze");
    tick(30);
    expect(say("/time")).toContain("12:0");
    say("/time resume");
    say("/timescale 600"); // a day in 12 seconds
    tick(6);
    expect(say("/time")).not.toContain("12:0");
  });

  it("explains a bad argument instead of failing silently", () => {
    const { say } = world();
    const out = say("/time banana");
    expect(out).toMatch(/^error:/);
    expect(out).toContain("dawn"); // it says what it WOULD take
  });

  it("drops a storm on the scene, and reports what is falling", () => {
    const { say, tick, lastWith } = world();
    expect(say("/weather storm")).toContain("storm");
    tick(20);
    expect(lastWith("weather").weather!.cloudDark!).toBeGreaterThan(0.3);
    const status = say("/weather");
    expect(status).toContain("rain");
    expect(status).toContain("mode storm");
    expect(say("/weather clear")).toContain("clear");
  });

  it("pins what precipitation falls as, so a sandstorm needs no desert", () => {
    const { say, tick } = world();
    say("/weather storm");
    say("/weather sand");
    tick(20);
    expect(say("/weather")).toContain("sand");
    expect(say("/weather biome")).toContain("biome");
  });

  it("points the wind, which is what the rain leans along", () => {
    const { say, tick } = world();
    say("/weather storm");
    expect(say("/wind 90 1")).toContain("90°");
    tick(6);
    expect(say("/wind")).toContain("(E)");
  });

  it("warns before changing world state from a tab that does not own it", () => {
    const { say } = world({ authority: false });
    const out = say("/time 3");
    expect(out).toMatch(/error:.*host owns/);
    expect(out).toContain("03:00"); // it still ran, and still says what it did
  });

  it("completes command names and remembers what was typed", () => {
    const { dev } = world();
    expect(dev.complete("/we")).toEqual(["weather"]);
    dev.run("/time noon");
    expect(dev.history()).toEqual(["/time noon"]);
  });

  it("answers a command the chat box already split for it", () => {
    const { dev } = world();
    const lines = dev.dispatch("time", ["dusk"]);
    expect(lines.map((l) => l.text).join()).toContain("18:00");
  });
});
