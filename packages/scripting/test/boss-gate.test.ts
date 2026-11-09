import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { applyOps, ComponentRegistry, createScene, NetStateStore, registerCoreComponents, type Op } from "@hitreg/core";
import { bossGateKey, bossGateCloseKey, bossGateProgress, isClockDrivenScript, registerBuiltinScripts, ScriptRegistry, ScriptRuntime, type SimLike } from "../src/index.js";

const core = new ComponentRegistry();
registerCoreComponents(core);

function run(params: Record<string, unknown>) {
  const ops: Op[] = [{ op: "add-entity", id: "gate", entity: { name: "gate", parent: null, tags: [], components: {
    transform: { position: [0, 10, 0] }, rigidbody: { kind: "kinematic" }, collider: { shape: "box", size: [4, 8, 1] }, script: { name: "boss-gate", params } } } }];
  ops.push({ op: "add-entity", id: "player", entity: { name: "player", parent: null, tags: ["player"], components: { transform: { position: [50, 0, 0] } } } });
  const doc = applyOps(createScene("gate"), ops, core).doc;
  const o = new THREE.Object3D(); o.name = "gate"; o.position.set(0, 10, 0);
  const player = new THREE.Object3D(); player.position.set(50, 0, 0);
  const root = new THREE.Scene(); root.add(o, player);
  const targets: number[] = [];
  const sim = { getLinvel: () => [0, 0, 0], setLinvel: () => undefined, applyImpulse: () => undefined,
    setKinematicTarget: (_id: string, p: [number, number, number]) => { targets.push(p[1]); o.position.set(p[0], p[1], p[2]); } } as unknown as SimLike;
  const netState = new NetStateStore();
  const registry = new ScriptRegistry(); registerBuiltinScripts(registry);
  const options = { doc, objects: new Map([["gate", o], ["player", player]]), sim, registry, input: { isDown: () => false }, netState };
  let runtime = new ScriptRuntime(options);
  runtime.start();
  const step = (sec: number) => { for (let i = 0; i < Math.round(sec * 60); i++) runtime.fixedUpdate(1 / 60); };
  const restart = () => { const now = runtime.now(); runtime.dispose(); runtime = new ScriptRuntime(options); runtime.syncClock(now, 0); runtime.start(); };
  return { o, player, netState, step, restart };
}

describe("boss-gate", () => {
  it("eases from shut to open over its seconds once latched", () => {
    expect(bossGateProgress(null, 100, 4)).toBe(0);
    expect(bossGateProgress(10, 9, 4)).toBe(0);
    expect(bossGateProgress(10, 12, 4)).toBeCloseTo(0.5);
    expect(bossGateProgress(10, 20, 4)).toBe(1);
    expect(bossGateProgress(10, 10, 0)).toBe(1);
  });

  it("stays shut while the boss lives, latches when it dies and sinks `drop` metres", () => {
    const { o, netState, step } = run({ boss: "ilhaset", drop: 8, seconds: 2 });
    netState.set("combat/ilhaset.hp", 50);
    step(3);
    expect(o.position.y).toBeCloseTo(10, 5);
    expect(netState.get(bossGateKey("gate"))).toBeUndefined();
    netState.set("combat/ilhaset.dead", true);
    step(3);
    expect(typeof netState.get(bossGateKey("gate"))).toBe("number");
    expect(o.position.y).toBeCloseTo(2, 3);
    // the boss respawns: the way stays open
    netState.set("combat/ilhaset.dead", false);
    step(1);
    expect(o.position.y).toBeCloseTo(2, 3);
  });

  it("is clock-driven (computed on every peer, never replicated)", () => {
    const registry = new ScriptRegistry(); registerBuiltinScripts(registry);
    expect(isClockDrivenScript(registry.get("boss-gate"))).toBe(true);
  });

  it("raises a portcullis with its collider, keeps the latch through a wipe and accepts a replicated opening", () => {
    const { o, netState, step, restart } = run({ boss: "arena-boss", drop: 6, direction: "up", seconds: 4 });
    step(1);
    expect(o.position.y).toBeCloseTo(10);
    netState.set("combat/arena-boss.dead", true);
    step(2);
    expect(o.position.y).toBeGreaterThan(12.8);
    expect(o.position.y).toBeLessThan(13.2);
    step(3);
    expect(o.position.y).toBeCloseTo(16);
    netState.set("combat/arena-boss.dead", false);
    step(1);
    expect(o.position.y).toBeCloseTo(16);
    restart(); step(.1); expect(o.position.y).toBeCloseTo(16);
    const late = run({ boss: "arena-boss", drop: 6, direction: "up", seconds: 4 });
    late.netState.set(bossGateKey("gate"), -10);
    late.step(0.1);
    expect(late.o.position.y).toBeCloseTo(16);
  });

  it("leaves an entrance open when players enter, closes only on boss aggro, then opens permanently after victory", () => {
    const { o, player, netState, step } = run({ boss: "champion", drop: 6, direction: "up", seconds: 2, closeOnAggro: true, closeSeconds: 2 });
    step(2); expect(o.position.y).toBeCloseTo(16);
    expect(netState.get(bossGateCloseKey("gate"))).toBeUndefined();
    player.position.set(0, 0, 0);
    step(1); expect(o.position.y).toBeCloseTo(16);
    expect(netState.get(bossGateCloseKey("gate"))).toBeUndefined();
    netState.set("target/champion", { primary: "player" }); step(1);
    expect(o.position.y).toBeGreaterThan(12.8); expect(o.position.y).toBeLessThan(13.2);
    step(2); expect(o.position.y).toBeCloseTo(10);
    netState.set("combat/champion.dead", true); step(3);
    expect(o.position.y).toBeCloseTo(16);
    netState.set("combat/champion.dead", false); step(2);
    expect(o.position.y).toBeCloseTo(16);
  });

  it("reverses smoothly if the champion dies during entrance closure", () => {
    const { o, netState, step } = run({ boss: "champion", drop: 6, direction: "up", seconds: 2, closeOnAggro: true, closeSeconds: 4 });
    netState.set("target/champion", { primary: "player" }); step(2);
    const before = o.position.y;
    netState.set("combat/champion.dead", true); step(1 / 60);
    // One last 60 Hz closure step is continuous motion, not a snap to shut.
    expect(Math.abs(o.position.y - before)).toBeLessThan(.05);
    step(1); expect(o.position.y).toBeGreaterThan(before); expect(o.position.y).toBeLessThan(16);
    step(2); expect(o.position.y).toBeCloseTo(16);
  });

  it("re-arms after sustained boss evade, ignores brief target switches, and never writes on a peer", () => {
    const params = { boss: "champion", drop: 6, direction: "up", seconds: 1, closeOnAggro: true, closeSeconds: 1, resetOnEvade: true, resetSeconds: .5 };
    const { o, netState, step } = run(params);
    netState.set("target/champion", { primary: "player" }); step(2); expect(o.position.y).toBeCloseTo(10);
    netState.delete("target/champion"); step(.3); expect(o.position.y).toBeCloseTo(10);
    netState.set("target/champion", { primary: "second-player" }); step(1); expect(o.position.y).toBeCloseTo(10);
    netState.delete("target/champion"); step(.3); expect(o.position.y).toBeCloseTo(10);
    step(.3); expect(o.position.y).toBeCloseTo(16); expect(netState.get(bossGateCloseKey("gate"))).toBeUndefined();
    netState.set("target/champion", { primary: "player" }); step(2); expect(o.position.y).toBeCloseTo(10);
    netState.set("combat/champion.dead", true); step(2);
    netState.delete("target/champion"); step(2); expect(o.position.y).toBeCloseTo(16);
    const peer = run(params); peer.netState.setAuthority(false);
    peer.netState.applyRemote({ delta: { set: { 'target/champion': { primary: 'player' } }, removed: [] } }); peer.step(2);
    expect(peer.netState.get(bossGateCloseKey("gate"))).toBeUndefined(); expect(peer.o.position.y).toBeCloseTo(16);
    // A replicated closure applies even when this peer's local player is outside.
    peer.player.position.set(50, 0, 0);
    peer.netState.applyRemote({ delta: { set: { [bossGateCloseKey("gate")]: 0 }, removed: [] } }); peer.step(.1);
    expect(peer.o.position.y).toBeCloseTo(10);
  });
});
