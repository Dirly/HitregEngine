import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { AUDIO_CHANNELS } from "@hitreg/core";
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
  setPosition() {}
  setOrientation() {}
}
function setup() {
  const nodes: Node[] = [];
  const make = () => { const node = new Node(); nodes.push(node); return node; };
  THREE.AudioContext.setContext({ currentTime: 0, destination: {}, createGain: make, createPanner: make, createBufferSource: make } as unknown as AudioContext);
  const host = new AudioSystem(new THREE.PerspectiveCamera(), () => undefined);
  const internals = host as unknown as {
    buffers: Map<string, Promise<AudioBuffer | null>>;
    live: Array<{ audio: THREE.Audio | THREE.PositionalAudio }>;
    loops: Map<string, { audio: THREE.Audio | null }>;
  };
  const buffer = { duration: 1 } as AudioBuffer;
  internals.buffers.set("a", Promise.resolve(buffer));
  internals.buffers.set("b", Promise.resolve(buffer));
  // the listener's gain and the channel buses stay connected for the life of the host
  const voices = () => nodes.slice(1 + AUDIO_CHANNELS.length);
  return { host, internals, nodes, voices, buffer };
}

test("loop gains are written only when changed; replacement and stop disconnect the entire graph", async () => {
  const { host, internals, voices } = setup();
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
  assert.ok(voices().every(node => node.connections.size === 0));
});

test("natural endings and voice eviction release sources, panners, gains and anchors", async () => {
  const { host, internals, voices } = setup(); const scene = new THREE.Scene();
  await host.playAt(scene, [0, 0, 0], "a");
  const audio = internals.live[0]!.audio;
  (audio.source as unknown as Node).onended!();
  assert.equal(audio.isPlaying, false); assert.equal(internals.live.length, 0);
  assert.equal(scene.children.length, 0);
  assert.ok(voices().every(node => node.connections.size === 0));
  for (let i = 0; i < 25; i++) await host.playAt(scene, [0, 0, 0], "a");
  assert.equal(internals.live.length, 24); assert.equal(scene.children.length, 24);
  // First evicted positional voice's gain, panner, and source are disconnected.
  assert.ok(voices().slice(3, 6).every(node => node.connections.size === 0));
  host.stopAll(); assert.equal(scene.children.length, 0);
  assert.ok(voices().every(node => node.connections.size === 0));
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

const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
const fire = (src = "a", extra = {}) => ({ components: { audio: { src, volume: 1, loop: true, autoplay: true, positional: true, refDistance: 3, ...extra } } });
/** An entity object at `x` metres from the listener, as a built place holds it. */
function placed(x: number): THREE.Object3D {
  const object = new THREE.Group();
  object.position.x = x;
  object.updateMatrixWorld();
  return object;
}

test("a positional sound with no object stays silent; a non-positional one still plays", async () => {
  const { host, internals } = setup();
  assert.equal(await host.play(null, "a", { loop: true }), false);
  assert.equal(await host.play(null, "a", { loop: true, positional: true }), false);
  assert.equal(internals.live.length, 0);
  assert.equal(await host.play(null, "a", { loop: true, positional: false }), true);
  assert.equal(internals.live.length, 1);
  assert.equal(internals.live[0]!.audio instanceof THREE.PositionalAudio, false);
});

test("a positional loop waits for its object instead of playing flat", async () => {
  const { host, internals } = setup(); const object = new THREE.Group();
  host.setLoop("emitter", null, "a"); await flush();
  assert.equal(internals.loops.size, 0);
  host.setLoop("emitter", object, "a"); await flush();
  assert.ok(internals.loops.get("emitter")!.audio instanceof THREE.PositionalAudio);
  host.setLoop("bed", null, "a", { positional: false }); await flush();
  assert.ok(internals.loops.get("bed")!.audio);
});

test("autoplay skips what is not built, and a place's loops sound only in earshot and end when it is freed", async () => {
  const { host, internals } = setup();
  const near = placed(5), far = placed(500);
  host.startAutoplay({ near: fire(), far: fire(), unbuilt: fire() }, new Map([["near", near], ["far", far]]));
  host.update(1000); await flush();
  assert.equal(internals.live.length, 1);
  assert.ok(internals.live[0]!.audio instanceof THREE.PositionalAudio);
  assert.equal(internals.live[0]!.audio.parent, near);
  far.position.x = 6; far.updateMatrixWorld();
  near.position.x = 400; near.updateMatrixWorld();
  host.update(2000); await flush();
  assert.equal(internals.live.length, 1);
  assert.equal(internals.live[0]!.audio.parent, far);
  host.stopAutoplay(["far", "near"]);
  assert.equal(internals.live.length, 0); assert.equal(far.children.length, 0);
  host.update(3000); await flush();
  assert.equal(internals.live.length, 0);
});

test("a town of fires takes the nearest voices and leaves room for one-shots; an evicted fire returns", async () => {
  const { host, internals } = setup(); const scene = new THREE.Scene();
  const entities: Record<string, ReturnType<typeof fire>> = {};
  const objects = new Map<string, THREE.Object3D>();
  for (let i = 0; i < 40; i++) { entities[`fire${i}`] = fire(); objects.set(`fire${i}`, placed(1 + i * 0.1)); }
  host.startAutoplay(entities, objects);
  host.update(1000); await flush();
  assert.equal(internals.live.length, 16);
  assert.ok(internals.live.every(voice => (voice.audio.parent!.position.x) < 2.6));
  for (let i = 0; i < 8; i++) await host.playAt(scene, [0, 0, 0], "a", { priority: 1 });
  assert.equal(internals.live.length, 24);
  await host.playAt(scene, [0, 0, 0], "a", { priority: 1 }); // evicts a fire: over the budget never
  assert.equal(internals.live.length, 24);
  host.update(2000); await flush();
  assert.equal(internals.live.length, 24); // no free voice: the fire waits, it does not evict a one-shot back
  host.stopAll(); host.update(3000); await flush();
  assert.equal(internals.live.length, 0); // the session is over
});

test("a non-positional autoplay loop plays at any distance; a one-shot autoplay ends with its place", async () => {
  const { host, internals } = setup();
  host.startAutoplay({ music: fire("a", { positional: false }) }, new Map([["music", placed(5000)]]));
  host.update(1000); await flush();
  assert.equal(internals.live.length, 1);
  assert.equal(internals.live[0]!.audio instanceof THREE.PositionalAudio, false);
  host.startAutoplay({ horn: fire("b", { loop: false }) }, new Map([["horn", placed(5)]])); await flush();
  assert.equal(internals.live.length, 2);
  host.stopAutoplay(["horn"]);
  assert.equal(internals.live.length, 1);
});

test("a rebuild moves autoplay loops onto the new objects and drops the entities that went", async () => {
  const { host, internals } = setup();
  const old = placed(5), other = placed(6), fresh = placed(5);
  host.startAutoplay({ kept: fire(), gone: fire() }, new Map([["kept", old], ["gone", other]]));
  host.update(1000); await flush();
  host.rebindAutoplay(new Map([["kept", fresh]]));
  assert.equal(internals.live.length, 0);
  host.update(2000); await flush();
  assert.equal(internals.live.length, 1);
  assert.equal(internals.live[0]!.audio.parent, fresh);
});

test("sounds route through their channel's bus; setMix drives each stage and the master", async () => {
  const { host, internals } = setup(); const scene = new THREE.Scene();
  const buses = (host as unknown as { buses: Map<string, Node> }).buses;
  await host.play(null, "a", { positional: false, channel: "interface" });
  await host.playAt(scene, [0, 0, 0], "a"); // untagged one-shot
  host.setLoop("bed", null, "a", { positional: false }); await flush(); // untagged loop
  host.setLoop("music", null, "a", { positional: false, channel: "music" }); await flush();
  const out = (audio: THREE.Audio | null | undefined) => (audio!.gain as unknown as Node).connections;
  assert.ok(out(internals.live[0]!.audio).has(buses.get("interface")));
  assert.ok(out(internals.live[1]!.audio).has(buses.get("effects")));
  assert.ok(out(internals.loops.get("bed")!.audio).has(buses.get("ambience")));
  assert.ok(out(internals.loops.get("music")!.audio).has(buses.get("music")));
  for (const bus of buses.values()) assert.equal(bus.connections.size, 1);
  host.setMix({ master: 0, channels: { music: 0.5, ambience: 0.25, effects: 1, interface: 0.75, voice: 1 } });
  assert.equal(buses.get("music")!.gain.value, 0.5);
  assert.equal(buses.get("ambience")!.gain.value, 0.25);
  const master = [...buses.get("music")!.connections][0] as Node;
  assert.equal(master.gain.value, 0);
});
