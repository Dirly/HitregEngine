import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EventRegistry, registerCoreEvents } from "../src/index.js";

function setup(): EventRegistry {
  const registry = new EventRegistry();
  registerCoreEvents(registry);
  return registry;
}

describe("EventRegistry", () => {
  it("registers the built-in engine events", () => {
    const registry = setup();
    expect(registry.names().sort()).toEqual([
      "animation.completed",
      "collision",
      "entity.destroyed",
      "entity.spawned",
      "player.joined",
      "player.left",
      "trigger.enter",
      "trigger.exit",
    ]);
    expect(registry.has("trigger.enter")).toBe(true);
    expect(registry.has("nope")).toBe(false);
  });

  it("tracks the replicate flag per event type", () => {
    const registry = setup();
    // roster events replicate to every peer; physics events stay local
    expect(registry.replicates("player.joined")).toBe(true);
    expect(registry.replicates("player.left")).toBe(true);
    expect(registry.replicates("collision")).toBe(false);
    expect(registry.replicates("entity.spawned")).toBe(false);
    expect(registry.replicates("never-registered")).toBe(false);
    registry.register("round.started", z.object({ round: z.number() }), { replicate: true });
    expect(registry.replicates("round.started")).toBe(true);
  });

  it("rejects duplicate registration", () => {
    const registry = setup();
    expect(() => registerCoreEvents(registry)).toThrow(/already registered/);
  });

  it("enforces the event name pattern", () => {
    const registry = new EventRegistry();
    expect(() => registry.register("Bad", z.object({}))).toThrow(/invalid/);
    expect(() => registry.register("9lives", z.object({}))).toThrow(/invalid/);
    expect(() => registry.register("has space", z.object({}))).toThrow(/invalid/);
    expect(() => registry.register("wave-cleared.final", z.object({}))).not.toThrow();
  });

  it("validates payloads against the schema", () => {
    const registry = setup();
    const ok = registry.validate("collision", { a: "x", b: "y" });
    expect(ok).toEqual({ ok: true, data: { a: "x", b: "y" } });
    const bad = registry.validate("collision", { a: "x" });
    expect(bad.ok).toBe(false);
    const unknown = registry.validate("no-such", {});
    expect(unknown).toMatchObject({ ok: false, error: expect.stringContaining("unknown event") });
  });

  it("normalizes payloads (defaults applied)", () => {
    const registry = new EventRegistry();
    registry.register("score", z.object({ amount: z.number().default(1) }));
    const result = registry.validate("score", {});
    expect(result).toEqual({ ok: true, data: { amount: 1 } });
  });

  it("exports JSON Schema per event for the AI spec", () => {
    const registry = setup();
    const schemas = registry.jsonSchemas();
    expect(Object.keys(schemas).sort()).toEqual(registry.names().sort());
    expect(schemas["trigger.enter"]).toMatchObject({
      type: "object",
      properties: { trigger: { type: "string" }, other: { type: "string" } },
    });
  });
});
