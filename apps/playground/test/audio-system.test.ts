import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { AudioSystem } from "../src/audio-system.js";

class Param {
  value = 1;
  writes = 0;
  setTargetAtTime(value: number) { this.value = value; this.writes++; }
}
class Node {
  connections = new Set<unknown>();
  gain = new Param();
  detune = new Param();
  playbackRate = new Param();
  onended: (() => void) | null = null;
  stopped = false;
  connect(node: unknown) { this.connections.add(node); }
  disconnect(node?: unknown) { if (node) this.connections.delete(node); else this.connections.clear(); }
  start() {}
  stop() { this.stopped = true; }
}
function setup() {
  const nodes: Node[] = [];
  const make = () => { const node = new Node(); nodes.push(node); return node; };
  THREE.AudioContext.setContext({ currentTime: 0, destination: {}, createGain: make, createPanner: make, createBufferSource: make } as unknown as AudioContext);
  const host = new AudioSystem(new THREE.PerspectiveCamera(), () => undefined);
  const internals = host as unknown as {
    buffers: Map<string, Promise<AudioBuffer | null>>;
    live: Array<{ audio: THREE.Audio }>;
    loops: Map<string, { audio: THREE.Audio | null }>;
  };
  const buffer = { duration: 1 } as AudioBuffer;
  internals.buffers.set("a", Promise.resolve(buffer));
  internals.buffers.set("b", Promise.resolve(buffer));
  return { host, internals, nodes, buffer };
}

test("loop gains are written only when changed; replacement and stop disconnect the entire graph", async () => {
  const { host, internals, nodes } = setup();
  const parent = new THREE.Group();
  host.setLoop("bed", parent, "a", { volume: 0.4 }); await Promise.resolve();
  const audio = internals.loops.get("bed")!.audio!;
  const gain = audio.gain as unknown as Node;
  const writes = gain.gain.writes;
  for (let i = 0; i < 120; i++) host.setLoop("bed", parent, "a", { volume: 0.4 });
  assert.equal(gain.gain.writes, writes);
  host.setLoop("bed", parent, "a", { volume: 0.2 });
  assert.equal(gain.gain.writes, writes + 1);
  host.setLoop("bed", parent, "b"); await Promise.resolve();
  assert.equal(audio.isPlaying, false); assert.equal(gain.connections.size, 0);
  host.stopAll(); host.stopAll();
  assert.equal(parent.children.length, 0);
  assert.ok(nodes.slice(1).every(node => node.connections.size === 0));
});

test("natural endings and voice eviction release sources, panners, gains and anchors", async () => {
  const { host, internals, nodes } = setup(); const scene = new THREE.Scene();
  await host.playAt(scene, [0, 0, 0], "a");
  const audio = internals.live[0]!.audio;
  (audio.source as unknown as Node).onended!();
  assert.equal(audio.isPlaying, false); assert.equal(internals.live.length, 0);
  assert.equal(scene.children.length, 0);
  assert.ok(nodes.slice(1).every(node => node.connections.size === 0));
  for (let i = 0; i < 25; i++) await host.playAt(scene, [0, 0, 0], "a");
  assert.equal(internals.live.length, 24); assert.equal(scene.children.length, 24);
  // First evicted positional voice's gain, panner, and source are disconnected.
  assert.ok(nodes.slice(4, 7).every(node => node.connections.size === 0));
  host.stopAll(); assert.equal(scene.children.length, 0);
  assert.ok(nodes.slice(1).every(node => node.connections.size === 0));
});

test("pending loads cannot resurrect audio from a stopped session, while a new session can play", async () => {
  const { host, internals, buffer } = setup(); const scene = new THREE.Scene();
  let finish!: (buffer: AudioBuffer) => void;
  internals.buffers.set("slow", new Promise(resolve => { finish = resolve; }));
  const pending = host.playAt(scene, [0, 0, 0], "slow", { loop: true });
  host.setLoop("bed", null, "slow"); host.stopAll(); finish(buffer); await pending;
  assert.equal(internals.live.length, 0); assert.equal(internals.loops.size, 0);
  assert.equal(scene.children.length, 0);
  assert.equal(await host.play(null, "slow", { positional: false }), true);
  host.stopAll();
});
