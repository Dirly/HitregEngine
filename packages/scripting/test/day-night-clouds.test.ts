import { describe, expect, it } from "vitest";
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

function scene(ops: Op[]): SceneDoc {
  return applyOps(createScene("t"), ops, coreRegistry).doc;
}

/**
 * The `day-night` script's sky, sampled at a given hour.
 *
 * `dayLength` of 24 makes one game hour one real second, so the clock is
 * driven by plain `fixedUpdate` seconds and a test can sit at dawn without
 * reaching inside the script.
 */
function skyAt(hour: number, params: Record<string, unknown> = {}): LiveSkyOptions {
  const doc = scene([
    {
      op: "add-entity",
      id: "sky",
      entity: {
        name: "Sky",
        parent: null,
        tags: [],
        components: { script: { name: "day-night", params: { dayLength: 24, startHour: hour, ...params } } },
      },
    },
  ]);
  const written: LiveSkyOptions[] = [];
  const registry = new ScriptRegistry();
  registerBuiltinScripts(registry);
  const runtime = new ScriptRuntime({
    doc,
    objects: new Map([["sky", new THREE.Object3D()]]),
    registry,
    // the sky script touches neither, but the runtime asks for both
    sim: { getLinvel: () => [0, 0, 0], setLinvel: () => {}, applyImpulse: () => {} },
    input: { isDown: () => false },
    setSky: (opts) => written.push(opts),
    getSky: () => ({
      top: "#39598f",
      bottom: "#101522",
      fog: null,
      hemisphere: 0.5,
      sun: { direction: [0.4, 0.55, 0.3], color: "#fff1d6", intensity: 1.2 },
      ambient: null,
      environmentIntensity: 1,
      clouds: { coverage: 0.45, softness: 0.35 },
    }),
  });
  runtime.start();
  return written[written.length - 1]!;
}

/** "#rrggbb" -> [r, g, b] in 0..255. */
function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

describe("day/night cloud colour", () => {
  it("lights the deck white at noon and cools it to blue at night — never the dawn orange", () => {
    const noon = skyAt(12).clouds!;
    const night = skyAt(0).clouds!;
    const [nr, ng, nb] = rgb(noon.color!);
    expect(nr).toBeGreaterThan(240);
    expect(ng).toBeGreaterThan(240);
    expect(nb).toBeGreaterThan(240);
    // the bug this replaced: at night `color` was the dawn colour, so midnight
    // cloud was a dim BROWN — red well above blue. It must now be the other way.
    const [mr, , mb] = rgb(night.color!);
    expect(mb).toBeGreaterThan(mr);
    expect(night.light!).toBeLessThan(0.25);
    expect(noon.light!).toBeGreaterThan(0.9);
  });

  it("opens the directional glow at the horizon and shuts it by mid-morning", () => {
    // sunrise is 6 and sunset 18 (the arc the script documents)
    expect(skyAt(6.2).clouds!.sunAmount!).toBeGreaterThan(0.6);
    expect(skyAt(18).clouds!.sunAmount!).toBeGreaterThan(0.6);
    expect(skyAt(12).clouds!.sunAmount!).toBeLessThan(0.05);
    expect(skyAt(1).clouds!.sunAmount!).toBeLessThan(0.05);
  });

  it("burns redder at the exact horizon than an hour later, and cloudGlow 0 turns it off", () => {
    const [hr, , hb] = rgb(skyAt(18).clouds!.sun!);
    const [ar, , ab] = rgb(skyAt(16.5).clouds!.sun!);
    // "redder" as a ratio, not an absolute: both are warm, the horizon more so
    expect(hr / Math.max(1, hb)).toBeGreaterThan(ar / Math.max(1, ab));
    expect(skyAt(18, { cloudGlow: 0 }).clouds!.sunAmount!).toBe(0);
  });
});
