import * as THREE from "three/webgpu";

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
}

/**
 * Play-mode audio host. The listener rides the render camera; positional
 * sources attach to entity objects. All runtime-only — stopped on ⏹.
 */
export class AudioSystem {
  private readonly listener = new THREE.AudioListener();
  private readonly buffers = new Map<string, Promise<AudioBuffer | null>>();
  private live: Array<{ audio: THREE.Audio | THREE.PositionalAudio; priority: number; anchor?: THREE.Object3D }> = [];
  /** Decoded lengths, for scripts that schedule around a track's end (music with silence between). */
  private readonly durations = new Map<string, number>();
  private readonly maxVoices = 24;
  /** A one-shot that took longer than this to load/decode is skipped (see play). */
  private readonly maxLateMs = 900;
  /** Long-lived, script-driven loops (weather, machinery, local ambience). */
  private loops = new Map<
    string,
    {
      soundId: string;
      volume: number;
      audio: THREE.Audio | THREE.PositionalAudio | null;
    }
  >();

  constructor(
    camera: THREE.Camera,
    private readonly resolveUrl: (soundId: string) => string | undefined,
  ) {
    camera.add(this.listener);
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

  async play(
    object: THREE.Object3D | null,
    soundId: string,
    opts: Partial<AudioComponentData> = {},
    anchor?: THREE.Object3D,
  ): Promise<boolean> {
    const asked = performance.now();
    const buffer = await this.load(soundId);
    if (!buffer) return false;
    // A one-shot is tied to its moment. One whose file only decoded after a
    // hitch (terrain streaming in, a first load) would play out of time, and
    // a stall releases them all at once: drop it instead.
    if (!opts.loop && performance.now() - asked > this.maxLateMs) return false;
    const priority = opts.priority ?? 0;
    if (this.live.length >= this.maxVoices) {
      let quietest = 0;
      for (let i = 1; i < this.live.length; i++) if (this.live[i]!.priority < this.live[quietest]!.priority) quietest = i;
      if (this.live[quietest]!.priority > priority) return false;
      const [evicted] = this.live.splice(quietest, 1);
      if (evicted!.audio.isPlaying) evicted!.audio.stop();
      evicted!.audio.removeFromParent();
      evicted!.anchor?.removeFromParent();
    }
    const positional = (opts.positional ?? true) && object !== null;
    const audio = positional
      ? new THREE.PositionalAudio(this.listener)
      : new THREE.Audio(this.listener);
    if (audio instanceof THREE.PositionalAudio) {
      audio.setRefDistance(opts.refDistance ?? 8);
      object!.add(audio);
    }
    audio.setBuffer(buffer);
    audio.setVolume(opts.volume ?? 1);
    audio.setPlaybackRate(opts.playbackRate ?? 1);
    audio.setLoop(opts.loop ?? false);
    const voice = { audio, priority, anchor };
    // Three binds this callback when play() creates its AudioBufferSourceNode.
    // Releasing naturally ended foley is essential: otherwise a long session
    // fills the priority budget with already-silent footsteps.
    audio.onEnded = () => {
      const index = this.live.indexOf(voice);
      if (index >= 0) this.live.splice(index, 1);
      audio.removeFromParent();
      anchor?.removeFromParent();
    };
    audio.play();
    this.live.push(voice);
    return true;
  }

  /** Keep one named loop alive and adjust its gain without restarting it. */
  setLoop(
    key: string,
    object: THREE.Object3D | null,
    soundId: string | undefined,
    opts: Partial<AudioComponentData> = {},
  ): void {
    const current = this.loops.get(key);
    if (!soundId) {
      if (current?.audio?.isPlaying) current.audio.stop();
      current?.audio?.removeFromParent();
      this.loops.delete(key);
      return;
    }
    if (current?.soundId === soundId) {
      current.volume = opts.volume ?? current.volume;
      current.audio?.setVolume(current.volume);
      return;
    }
    if (current?.audio?.isPlaying) current.audio.stop();
    current?.audio?.removeFromParent();
    const loop = { soundId, volume: opts.volume ?? 1, audio: null as THREE.Audio | THREE.PositionalAudio | null };
    this.loops.set(key, loop);
    void this.load(soundId).then((buffer) => {
      // A later weather sample may have stopped or replaced this loop while it loaded.
      if (!buffer || this.loops.get(key) !== loop) return;
      const positional = (opts.positional ?? true) && object !== null;
      const audio = positional ? new THREE.PositionalAudio(this.listener) : new THREE.Audio(this.listener);
      if (audio instanceof THREE.PositionalAudio) {
        audio.setRefDistance(opts.refDistance ?? 8);
        object!.add(audio);
      }
      audio.setBuffer(buffer);
      audio.setVolume(loop.volume);
      audio.setPlaybackRate(opts.playbackRate ?? 1);
      audio.setLoop(true);
      audio.play();
      loop.audio = audio;
    });
  }

  stopAll(): void {
    for (const { audio, anchor } of this.live) {
      try {
        if (audio.isPlaying) audio.stop();
      } catch {
        /* already ended */
      }
      audio.removeFromParent();
      anchor?.removeFromParent();
    }
    this.live = [];
    for (const loop of this.loops.values()) {
      try {
        if (loop.audio?.isPlaying) loop.audio.stop();
      } catch {
        /* already ended */
      }
      loop.audio?.removeFromParent();
    }
    this.loops.clear();
  }
}
