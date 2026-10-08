import { describe, expect, it, vi } from "vitest";
import { createScene } from "@hitreg/core";
import { Object3D } from "three";
import { Script, ScriptRegistry, ScriptRuntime } from "../src/index.js";

describe("late script profiling", () => {
  it("attributes late work by script name and balances scopes after a failure", () => {
    class Late extends Script {
      static override scriptName = "late-audio";
      override onLateUpdate() { throw Error("test failure"); }
    }
    const registry = new ScriptRegistry(); registry.register(Late);
    const doc = createScene("test");
    doc.entities.a = { name: "a", parent: null, tags: [], components: { script: { name: "late-audio", params: {} } } };
    const profiler = { enabled: true, begin: vi.fn(), end: vi.fn(), mark: vi.fn(), span: vi.fn(() => () => {}) };
    const runtime = new ScriptRuntime({ doc, objects: new Map([["a", new Object3D()]]), sim: null, input: { isDown: () => false }, registry, profiler });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      runtime.start(); runtime.lateUpdate(1 / 60);
      expect(profiler.begin).toHaveBeenCalledWith("late-audio");
      expect(profiler.end).toHaveBeenCalledTimes(1);
      profiler.enabled = false; runtime.lateUpdate(1 / 60);
      expect(profiler.begin).toHaveBeenCalledTimes(1);
      expect(profiler.end).toHaveBeenCalledTimes(1);
    } finally { error.mockRestore(); runtime.dispose(); }
  });
});
