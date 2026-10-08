import { describe, expect, it } from "vitest";
import { EncounterWavesScript, WaveTracker, npcSpawnEventSchema } from "../src/index.js";

/** The pure decisions of the encounter-waves boss mechanic. */
function tracker(maxAlive = 4) {
  const t = new WaveTracker({ waves: [{ atHp: 1, count: 3, mouths: ["a"] }, { atHp: 0.5, count: 4, mouths: ["a", "b"] }], maxAlive, corpseTicks: 10 });
  const dead = new Set<string>(), gone = new Set<string>();
  let tick = 0, n = 0;
  const run = (fraction: number | null, bossDead = false) => {
    const out = t.update({ fraction, bossDead, tick: ++tick, isDead: (id) => dead.has(id), exists: (id) => !gone.has(id) });
    const ids = out.spawn.map((s) => { const id = `add${++n}`; t.added(id); return { id, ...s }; });
    for (const id of out.despawn) gone.add(id);
    return { ...out, ids };
  };
  return { t, run, dead, gone };
}

describe("encounter-waves", () => {
  it("waits while the boss is untouched or has no health", () => {
    const { run } = tracker();
    expect(run(null).spawn).toEqual([]);
    expect(run(1).spawn).toEqual([]);
  });

  it("fires an atHp 1 wave on the first hit, out of its mouths", () => {
    const { run } = tracker();
    const out = run(0.99);
    expect(out.spawn).toEqual([{ mouth: "a", wave: 0 }, { mouth: "a", wave: 0 }, { mouth: "a", wave: 0 }]);
  });

  it("caps live adds, queues the rest, deals mouths round-robin and fires each wave once", () => {
    const { run, dead, t } = tracker();
    const first = run(0.4);
    expect(first.spawn.length).toBe(4);
    expect(run(0.3).spawn.length).toBe(0);
    dead.add(first.ids[0]!.id);
    dead.add(first.ids[1]!.id);
    const more = run(0.3);
    expect(more.spawn.map((s) => s.mouth)).toEqual(["b", "a"]);
    expect([...t.fired].sort()).toEqual([0, 1]);
  });

  it("removes dead adds after the corpse grace (no respawn)", () => {
    const { run, dead } = tracker();
    const out = run(0.9);
    dead.add(out.ids[0]!.id);
    let despawned: string[] = [];
    for (let i = 0; i < 12; i++) despawned = despawned.concat(run(0.9).despawn);
    expect(despawned).toEqual([out.ids[0]!.id]);
  });

  it("re-arms after the boss dies and its adds are gone, so a farmed boss replays", () => {
    const { run, dead, t } = tracker();
    const out = run(0.9);
    run(0, true);
    for (const a of out.ids) dead.add(a.id);
    for (let i = 0; i < 12; i++) run(null, true);
    expect(t.fired.size).toBe(0);
    expect(run(0.95).spawn.length).toBe(3);
  });

  it("is a parameter-only builtin with its events schema-described", () => {
    expect(EncounterWavesScript.scriptName).toBe("encounter-waves");
    expect(Object.keys(EncounterWavesScript.params)).toEqual(expect.arrayContaining(["boss", "template", "mouths", "waves", "maxAlive"]));
    expect(EncounterWavesScript.events.map((e) => e.name)).toEqual(["npc.spawn", "npc.despawn"]);
    expect(npcSpawnEventSchema.parse({ template: "t", id: "x", at: [0, 0, 0] })).toMatchObject({ yaw: 0, params: {} });
  });
});
