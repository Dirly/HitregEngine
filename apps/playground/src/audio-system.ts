import * as THREE from "three/webgpu";
import { AUDIO_CHANNELS, type AudioChannel } from "@hitreg/core";
import { channelOf, type AudioMix } from "./audio-settings.js";

export interface AudioComponentData {
  src: string;
  volume: number;
  loop: boolean;
  autoplay: boolean;
  positional: boolean;
  refDistance: number;
  playbackRate: number;
  /** Higher-priority transient sounds may evict this one when the voice budget is full. */
  priority: number;
  /** Mixer channel; unset goes by `channelOf`. */
  channel: AudioChannel;
}

type Source = THREE.Audio | THREE.PositionalAudio;

interface Voice {
  audio: Source;
  priority: number;
  anchor?: THREE.Object3D | undefined;
  /** The entity whose autoplay component started this voice. */
  owner?: string | undefined;
}

/** An autoplay loop on a built entity: it holds a voice only while the listener can hear it. */
interface Emitter {
  object: THREE.Object3D;
  comp: AudioComponentData;
  voice: Voice | null;
  starting: boolean;
}

/** The part of an entity `startAutoplay` reads. */
interface AudioEntity {
  components: Record<string, unknown>;
}

/**
 * Play-mode audio host. The listener rides the render camera; positional
 * sources attach to entity objects. All runtime-only — stopped on ⏹.
 */
/** A positional sound reaches silence at this many times its `refDistance`. */
const SILENT_AT_REF_DISTANCES = 8;

/**
 * Web Audio's default falloff never reaches zero: a hearth is still 3% at 100 m, so a town's dozens of looping fires
 * summed into one crackle heard from everywhere. Linear falloff ends, so a fire is only audible near it.
 */
function fadeOut(audio: THREE.PositionalAudio, refDistance: number): void {
  audio.setRefDistance(refDistance);
  audio.setDistanceModel("linear");
  audio.setMaxDistance(refDistance * SILENT_AT_REF_DISTANCES);
}

export class AudioSystem {
  private readonly listener = new THREE.AudioListener();
  private readonly buffers = new Map<string, Promise<AudioBuffer | null>>();
  private live: Voice[] = [];
  /** One gain stage per mixer channel, all feeding the listener's master gain. */
  private readonly buses = new Map<AudioChannel, GainNode>();
  /** Autoplay loops by entity id: a town has more fires than voices, so only the nearest sound. */
  private readonly emitters = new Map<string, Emitter>();
  private nextEmitterCheck = 0;
  /** Decoded lengths, for scripts that schedule around a track's end (music with silence between). */
  private readonly durations = new Map<string, number>();
  private readonly maxVoices = 24;
  /** Autoplay loops never take the whole budget: one-shots keep the rest without evicting them. */
  private readonly maxEmitterVoices = 16;
  private readonly emitterCheckMs = 250;
  /** A one-shot that took longer than this to load/decode is skipped (see play). */
  private readonly maxLateMs = 900;
  /** Invalidates pending play requests when leaving/restarting a play session. */
  private generation = 0;
  /** Long-lived, script-driven loops (weather, machinery, local ambience). */
  private loops = new Map<
    string,
    {
      soundId: string;
      volume: number;
      audio: Source | null;
    }
  >();

  constructor(
    camera: THREE.Camera,
    private readonly resolveUrl: (soundId: string) => string | undefined,
  ) {
    camera.add(this.listener);
    for (const channel of AUDIO_CHANNELS) {
      const bus = this.listener.context.createGain();
      bus.connect(this.listener.getInput());
      this.buses.set(channel, bus);
    }
  }

  /** The player's mix. Every sound passes through a channel bus and the master, so a master of 0 silences everything. */
  setMix(mix: AudioMix): void {
    this.listener.setMasterVolume(mix.master);
    const now = this.listener.context.currentTime;
    for (const [channel, bus] of this.buses) bus.gain.setTargetAtTime(mix.channels[channel], now, 0.01);
  }

  /** Move a new sound off the listener's input onto its channel's bus. */
  private route(audio: Source, channel: AudioChannel): void {
    audio.gain.disconnect();
    audio.gain.connect(this.buses.get(channel)!);
  }

  /**
   * Begin playback. An entity with an `audio` component counts as still, and a frozen subtree is never walked again
   * (static-transforms.ts), so a sound under one must place its panner now or it stays at the world origin.
   */
  private start(audio: Source): void {
    audio.play();
    if (audio instanceof THREE.PositionalAudio) audio.updateMatrixWorld(true);
  }

  /** Browser autoplay policy: resume the context on the play-button gesture. */
  resume(): void {
    void this.listener.context.resume();
  }

  private load(soundId: string): Promise<AudioBuffer | null> {
    let pending = this.buffers.get(soundId);
    if (!pending) {
      const url = this.resolveUrl(soundId);
      pending = url
        ? new THREE.AudioLoader()
            .loadAsync(url)
            .then((buffer) => {
              this.durations.set(soundId, buffer.duration);
              return buffer;
            })
            .catch((error) => {
              console.warn(`[audio] failed to load ${soundId}:`, error);
              return null;
            })
        : Promise.resolve(null);
      this.buffers.set(soundId, pending);
    }
    return pending;
  }

  /** Seconds of a decoded sound; undefined until it has loaded once. */
  duration(soundId: string): number | undefined {
    return this.durations.get(soundId);
  }

  /** Warm a sound so its duration is known before it is needed. */
  preload(soundId: string): void {
    void this.load(soundId);
  }

  /**
   * A positional one-shot at a world point: an anchor is parked under `parent`
   * (the scene root) for the sound's life and removed with it.
   */
  async playAt(
    parent: THREE.Object3D,
    at: readonly [number, number, number],
    soundId: string,
    opts: Partial<AudioComponentData> = {},
  ): Promise<void> {
    const anchor = new THREE.Object3D();
    anchor.position.set(at[0], at[1], at[2]);
    parent.add(anchor);
    anchor.updateMatrixWorld();
    const started = await this.play(anchor, soundId, { ...opts, positional: true }, anchor);
    if (!started) anchor.removeFromParent();
  }

  /**
   * A positional sound with no object has nowhere to be, so it does not play: heard flat it would fill the whole map at
   * full volume. An entity in a place that has not streamed in yet has no object.
   */
  async play(
    object: THREE.Object3D | null,
    soundId: string,
    opts: Partial<AudioComponentData> = {},
    anchor?: THREE.Object3D,
    owner?: string,
  ): Promise<boolean> {
    if ((opts.positional ?? true) && object === null) return false;
    const generation = this.generation;
    const asked = performance.now();
    const buffer = await this.load(soundId);
    if (!buffer || generation !== this.generation) return false;
    // A one-shot is tied to its moment. One whose file only decoded after a
    // hitch (terrain streaming in, a first load) would play out of time, and
    // a stall releases them all at once: drop it instead.
    if (!opts.loop && performance.now() - asked > this.maxLateMs) return false;
    return this.startVoice(object, buffer, opts, anchor, owner) !== null;
  }

  private startVoice(
    object: THREE.Object3D | null,
    buffer: AudioBuffer,
    opts: Partial<AudioComponentData>,
    anchor?: THREE.Object3D,
    owner?: string,
  ): Voice | null {
    const priority = opts.priority ?? 0;
    if (this.live.length >= this.maxVoices) {
      let quietest = 0;
      for (let i = 1; i < this.live.length; i++) if (this.live[i]!.priority < this.live[quietest]!.priority) quietest = i;
      if (this.live[quietest]!.priority > priority) return null;
      const [evicted] = this.live.splice(quietest, 1);
      this.endVoice(evicted!);
    }
    const audio = (opts.positional ?? true)
      ? new THREE.PositionalAudio(this.listener)
      : new THREE.Audio(this.listener);
    if (audio instanceof THREE.PositionalAudio) {
      fadeOut(audio, opts.refDistance ?? 8);
      object!.add(audio);
    }
    this.route(audio, channelOf(opts));
    audio.setBuffer(buffer);
    audio.setVolume(opts.volume ?? 1);
    audio.setPlaybackRate(opts.playbackRate ?? 1);
    audio.setLoop(opts.loop ?? false);
    const voice: Voice = { audio, priority, anchor, owner };
    // Three binds this callback when play() creates its AudioBufferSourceNode.
    // Releasing naturally ended foley is essential: otherwise a long session
    // fills the priority budget with already-silent footsteps.
    audio.onEnded = () => {
      // Preserve Three's state bookkeeping before releasing the audio graph.
      THREE.Audio.prototype.onEnded.call(audio);
      const index = this.live.indexOf(voice);
      if (index >= 0) this.live.splice(index, 1);
      this.release(audio);
      anchor?.removeFromParent();
    };
    this.start(audio);
    this.live.push(voice);
    return voice;
  }

  /** Release a voice already taken out of `live`; its emitter, if any, may start again later. */
  private endVoice(voice: Voice): void {
    this.release(voice.audio);
    voice.anchor?.removeFromParent();
    const emitter = voice.owner === undefined ? undefined : this.emitters.get(voice.owner);
    if (emitter?.voice === voice) emitter.voice = null;
  }

  /**
   * Start the autoplay `audio` components of entities that are built now. An entity with no object is skipped: its place
   * calls this again when it streams in.
   */
  startAutoplay(entities: Readonly<Record<string, AudioEntity>>, objects: ReadonlyMap<string, THREE.Object3D>): void {
    for (const [id, entity] of Object.entries(entities)) {
      const comp = entity.components["audio"] as AudioComponentData | undefined;
      if (!comp?.autoplay) continue;
      const object = objects.get(id);
      if (!object) continue;
      if (comp.loop) {
        this.stopAutoplay([id]);
        this.emitters.set(id, { object, comp, voice: null, starting: false });
        this.nextEmitterCheck = 0;
      } else void this.play(object, comp.src, comp, undefined, id);
    }
  }

  /** The entities are leaving (their place was freed): their autoplay sounds end with them. */
  stopAutoplay(ids: Iterable<string>): void {
    const gone = new Set(ids);
    const ending = this.live.filter((voice) => voice.owner !== undefined && gone.has(voice.owner));
    if (ending.length) {
      this.live = this.live.filter((voice) => !ending.includes(voice));
      for (const voice of ending) this.endVoice(voice);
    }
    for (const id of gone) this.emitters.delete(id);
  }

  /** A rebuild replaced the runtime objects: autoplay loops follow their entities onto the new ones. */
  rebindAutoplay(objects: ReadonlyMap<string, THREE.Object3D>): void {
    for (const [id, emitter] of this.emitters) {
      const object = objects.get(id);
      if (object === emitter.object) continue;
      if (object) {
        this.silence(emitter);
        emitter.object = object;
      } else this.stopAutoplay([id]);
    }
    this.nextEmitterCheck = 0;
  }

  private silence(emitter: Emitter): void {
    const { voice } = emitter;
    if (!voice) return;
    this.live.splice(this.live.indexOf(voice), 1);
    this.endVoice(voice);
  }

  private startEmitter(id: string, emitter: Emitter): void {
    emitter.starting = true;
    void this.load(emitter.comp.src).then((buffer) => {
      emitter.starting = false;
      // stopped or replaced while it loaded; with no voice free it tries again on a later check
      if (!buffer || this.emitters.get(id) !== emitter || this.live.length >= this.maxVoices) return;
      emitter.voice = this.startVoice(emitter.object, buffer, emitter.comp, undefined, id);
    });
  }

  /**
   * Called every frame by the host; the work runs a few times a second. Linear falloff reaches silence, so a loop starts
   * and stops at the edge of earshot without a click, and the nearest take the voices when more are in range.
   */
  update(now = performance.now()): void {
    if (now < this.nextEmitterCheck || this.emitters.size === 0) return;
    this.nextEmitterCheck = now + this.emitterCheckMs;
    const ear = this.listener.matrixWorld.elements;
    const audible: Array<{ id: string; emitter: Emitter; distance: number }> = [];
    for (const [id, emitter] of this.emitters) {
      const { comp, object, voice } = emitter;
      const at = object.matrixWorld.elements;
      const distance = comp.positional === false ? 0 : Math.hypot(at[12]! - ear[12]!, at[13]! - ear[13]!, at[14]! - ear[14]!);
      // a little further to stop than to start, so a player on the edge does not restart it over and over
      const reach = (comp.refDistance ?? 8) * SILENT_AT_REF_DISTANCES * (voice ? 1.1 : 1);
      if (comp.positional === false || distance < reach) audible.push({ id, emitter, distance });
      else this.silence(emitter);
    }
    audible.sort((a, b) => a.distance - b.distance);
    for (const [rank, { id, emitter }] of audible.entries()) {
      if (rank >= this.maxEmitterVoices) this.silence(emitter);
      else if (!emitter.voice && !emitter.starting && this.live.length < this.maxVoices) this.startEmitter(id, emitter);
    }
  }

  /** Keep one named loop alive and adjust its gain without restarting it. */
  setLoop(
    key: string,
    object: THREE.Object3D | null,
    soundId: string | undefined,
    opts: Partial<AudioComponentData> = {},
  ): void {
    const current = this.loops.get(key);
    // no object yet: ask again next frame, by when its place may have streamed in (see `play`)
    if (!soundId || ((opts.positional ?? true) && object === null)) {
      if (current?.audio) this.release(current.audio);
      this.loops.delete(key);
      return;
    }
    if (current?.soundId === soundId) {
      const volume = opts.volume ?? current.volume;
      if (volume !== current.volume) {
        current.volume = volume;
        current.audio?.setVolume(volume);
      }
      return;
    }
    if (current?.audio) this.release(current.audio);
    const loop = { soundId, volume: opts.volume ?? 1, audio: null as Source | null };
    this.loops.set(key, loop);
    void this.load(soundId).then((buffer) => {
      // A later weather sample may have stopped or replaced this loop while it loaded.
      if (!buffer || this.loops.get(key) !== loop) return;
      const audio = (opts.positional ?? true) ? new THREE.PositionalAudio(this.listener) : new THREE.Audio(this.listener);
      if (audio instanceof THREE.PositionalAudio) {
        fadeOut(audio, opts.refDistance ?? 8);
        object!.add(audio);
      }
      this.route(audio, channelOf({ ...opts, loop: true }));
      audio.setBuffer(buffer);
      audio.setVolume(loop.volume);
      audio.setPlaybackRate(opts.playbackRate ?? 1);
      audio.setLoop(true);
      this.start(audio);
      loop.audio = audio;
    });
  }

  /** Scene removal alone does not disconnect Web Audio nodes. */
  private release(audio: Source): void {
    if (audio.isPlaying) audio.stop();
    if (audio.source && "onended" in audio.source) audio.source.onended = null;
    audio.disconnect();
    audio.gain.disconnect();
    audio.removeFromParent();
  }

  stopAll(): void {
    this.generation++;
    this.emitters.clear();
    for (const { audio, anchor } of this.live) {
      this.release(audio);
      anchor?.removeFromParent();
    }
    this.live = [];
    for (const loop of this.loops.values()) {
      if (loop.audio) this.release(loop.audio);
    }
    this.loops.clear();
  }
}
