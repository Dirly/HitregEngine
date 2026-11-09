import { test } from "node:test";
import assert from "node:assert/strict";
import { AUDIO_STORAGE_KEY, AudioSettingsController, DEFAULT_AUDIO, audioMix, channelOf, loadAudio, voiceGain, type AudioMix } from "../src/audio-settings.js";

function storage(initial?: string) {
  const data = new Map<string, string>(initial === undefined ? [] : [[AUDIO_STORAGE_KEY, initial]]);
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) };
}

test("an untagged loop is ambience, anything else effects, and a tag wins", () => {
  assert.equal(channelOf({ loop: true }), "ambience");
  assert.equal(channelOf({}), "effects");
  assert.equal(channelOf({ loop: true, channel: "music" }), "music");
  assert.equal(channelOf({ channel: "interface" }), "interface");
});

test("stored levels load; garbage and out-of-range values fall back to the defaults", () => {
  assert.deepEqual(loadAudio(null), DEFAULT_AUDIO);
  assert.deepEqual(loadAudio(storage("not json")), DEFAULT_AUDIO);
  assert.deepEqual(loadAudio(storage("null")), DEFAULT_AUDIO);
  const loaded = loadAudio(storage(JSON.stringify({ music: 0.4, ambience: 7, effects: "x", muted: true })));
  assert.deepEqual(loaded, { ...DEFAULT_AUDIO, music: 0.4, muted: true });
});

test("mute silences the master and voice but keeps the levels", () => {
  const settings = { ...DEFAULT_AUDIO, master: 0.5, voice: 0.5 };
  assert.equal(audioMix(settings).master, 0.5);
  assert.equal(voiceGain(settings), 0.25);
  const muted = { ...settings, muted: true };
  assert.equal(audioMix(muted).master, 0);
  assert.equal(audioMix(muted).channels.voice, 0.5);
  assert.equal(voiceGain(muted), 0);
});

test("the controller applies at boot, applies and saves every change, and reaches voice once it exists", () => {
  const store = storage(JSON.stringify({ master: 0.5 }));
  const mixes: AudioMix[] = [];
  const gains: number[] = [];
  let voice: { setOutputGain(gain: number): void } | null = null;
  const controller = new AudioSettingsController({ setMix: (mix) => mixes.push(mix), voice: () => voice }, store);
  assert.equal(mixes.at(-1)!.master, 0.5);
  voice = { setOutputGain: (gain) => gains.push(gain) };
  let told = 0;
  controller.subscribe(() => told++);
  controller.change({ music: 0.2 });
  assert.equal(mixes.at(-1)!.channels.music, 0.2);
  assert.deepEqual(gains, [0.5]);
  assert.equal(told, 1);
  controller.change({ muted: true });
  assert.equal(mixes.at(-1)!.master, 0);
  assert.deepEqual(gains, [0.5, 0]);
  assert.deepEqual(loadAudio(store), { ...DEFAULT_AUDIO, master: 0.5, music: 0.2, muted: true });
});
