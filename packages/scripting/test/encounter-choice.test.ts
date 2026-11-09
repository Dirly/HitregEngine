import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { EventRegistry, NetStateStore, registerEncounterNetState } from "@hitreg/core";
import { EventBus, EncounterChoiceScript, encounterChoiceKey, type ScriptContext } from "../src/index.js";

function setup(authority = true, selected?: string) {
  const netState = new NetStateStore(); registerEncounterNetState(netState); netState.setAuthority(authority);
  if (selected !== undefined) { netState.setAuthority(true); netState.set(encounterChoiceKey("arena"), selected); netState.setAuthority(authority); }
  const registry = new EventRegistry();
  for (const e of EncounterChoiceScript.events) registry.register(e.name, e.schema);
  const events = new EventBus(registry), spawns: any[] = [];
  events.on("npc.spawn", (p) => spawns.push(p));
  const object = new THREE.Object3D(); object.position.set(0, -6, -246);
  const script = new EncounterChoiceScript();
  script.ctx = { entityId: "arena", object, netState, events, params: { actor: "champion", choices: ["prefab:mage", "prefab:warden"], leash: 20, yaw: 0 }, getEntity: () => undefined } as unknown as ScriptContext;
  return { script, netState, spawns, step: () => { script.onFixedUpdate(); events.drain(); } };
}

describe("encounter-choice", () => {
  it.each([0, 0.999])("rolls either alternative once and spawns exactly one stable actor (%s)", (roll) => {
    const random = vi.spyOn(Math, "random").mockReturnValue(roll);
    try {
      const { step, netState, spawns } = setup();
      step(); step();
      expect(spawns).toHaveLength(1);
      expect(spawns[0]).toMatchObject({ id: "champion", template: roll === 0 ? "prefab:mage" : "prefab:warden", respawn: false, at: [0, -6, -246] });
      expect(netState.get(encounterChoiceKey("arena"))).toBe(spawns[0].template);
    } finally { random.mockRestore(); }
  });
  it("honors an existing instance choice and does not reroll when the script restarts", () => {
    const { step, spawns } = setup(true, "prefab:warden");
    step();
    expect(spawns[0].template).toBe("prefab:warden");
  });
  it("does not spawn or roll on a peer, after victory, or over a live actor", () => {
    const peer = setup(false); peer.script.onFixedUpdate(); expect(peer.spawns).toEqual([]);
    const won = setup(); won.netState.set("combat/champion.dead", true); won.script.onFixedUpdate(); expect(won.spawns).toEqual([]);
    const live = setup(); live.script.ctx.getEntity = () => ({}) as any; live.script.onFixedUpdate(); expect(live.spawns).toEqual([]);
  });
});
