import { describe, expect, it } from "vitest";
import { MOB_BEHAVIOR_ARCHETYPES, mobBehaviorArchetypeSchema, mobBehaviorOverride, resolveMobBehavior, spawnAreaSchema, mobEventDecls } from "../src/index.js";

describe("reusable mob behavior policies", () => {
  it("validates alert provenance and indirect threat while keeping legacy event payloads valid", () => {
    const alert = mobEventDecls.find(e => e.name === "mob.alert")!.schema;
    const legacy = { mobId: "a", targetId: "p", at: [0, 0, 0], radius: 10 };
    expect(alert.safeParse(legacy).success).toBe(true);
    expect(alert.safeParse({ ...legacy, cause: "defense", spawnArea: "nest" }).success).toBe(true);
    expect(alert.safeParse({ ...legacy, cause: "friendly" }).success).toBe(false);
    const threat = mobEventDecls.find(e => e.name === "mob.threat")!.schema;
    expect(threat.safeParse({ mobId: "a", sourceId: "p", amount: 1 }).success).toBe(true);
    expect(threat.safeParse({ mobId: "a", sourceId: "healer", amount: 1, provoked: false }).success).toBe(true);
    expect(threat.safeParse({ mobId: "a", sourceId: "p", provoked: "false" }).success).toBe(false);
  });
  it("maps named policies and keeps inherit's legacy defaults and explicit social choices", () => {
    expect(resolveMobBehavior({})).toEqual({ temperament: "hostile", alertRadius: 10, defensiveAssistOnly: false });
    expect(resolveMobBehavior({ behaviorArchetype: "inherit", temperament: "passive" }).alertRadius).toBe(0);
    expect(resolveMobBehavior({ temperament: "passive", alertRadius: 14 }).alertRadius).toBe(14);
    expect(resolveMobBehavior({ temperament: "unknown", alertRadius: 0 }).temperament).toBe("hostile");
    expect(resolveMobBehavior({ behaviorArchetype: "neutral", temperament: "hostile", alertRadius: 50 })).toEqual({ temperament: "passive", alertRadius: 0, defensiveAssistOnly: false });
    expect(resolveMobBehavior({ behaviorArchetype: "protective", alertRadius: 0 })).toEqual({ temperament: "passive", alertRadius: 10, defensiveAssistOnly: true });
    expect(resolveMobBehavior({ behaviorArchetype: "protective", alertRadius: 14 }).alertRadius).toBe(14);
    expect(resolveMobBehavior({ behaviorArchetype: "aggressive", temperament: "passive", alertRadius: 0 })).toEqual({ temperament: "hostile", alertRadius: 0, defensiveAssistOnly: false });
    expect(resolveMobBehavior({ behaviorArchetype: "territorial" }).temperament).toBe("territorial");
  });

  it("selects the highest authored scope as a policy, including an explicit legacy mood or inherit", () => {
    const template = { behaviorArchetype: "protective" as const };
    expect(mobBehaviorOverride({}, {}, template)).toEqual(template);
    expect(mobBehaviorOverride({}, { temperament: "hostile" }, template)).toEqual({ behaviorArchetype: "inherit", temperament: "hostile" });
    expect(mobBehaviorOverride({ behaviorArchetype: "neutral" }, { behaviorArchetype: "aggressive" }, template)).toEqual({ behaviorArchetype: "neutral" });
    expect(mobBehaviorOverride({ behaviorArchetype: "inherit" }, template)).toEqual({ behaviorArchetype: "inherit" });
  });

  it("validates the same choices at area, fixed member, mix and rare scopes without adding an authored default", () => {
    for (const behaviorArchetype of MOB_BEHAVIOR_ARCHETYPES) {
      expect(mobBehaviorArchetypeSchema.parse(behaviorArchetype)).toBe(behaviorArchetype);
      const doc = spawnAreaSchema.parse({ behaviorArchetype, spawns: [{ template: "worker", behaviorArchetype }], mix: [{ template: "soldier", behaviorArchetype }], rares: [{ template: "queen", chance: .1, behaviorArchetype }] });
      expect([doc.behaviorArchetype, doc.spawns[0]!.behaviorArchetype, doc.mix[0]!.behaviorArchetype, doc.rares[0]!.behaviorArchetype]).toEqual(Array(4).fill(behaviorArchetype));
    }
    expect(spawnAreaSchema.parse({}).behaviorArchetype).toBeUndefined();
    expect(spawnAreaSchema.safeParse({ mix: [{ template: "a", behaviorArchetype: "peaceful" }] }).success).toBe(false);
  });
});
