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
  private live: Array<{ audio: THREE.Audio | THREE.PositionalAudio; priority: number }> = [];
  private readonly maxVoices = 24;
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
            .catch((error) => {
              console.warn(`[audio] failed to load ${soundId}:`, error);
              return null;
            })
        : Promise.resolve(null);
      this.buffers.set(soundId, pending);
    }
    return pending;
  }

  async play(
    object: THREE.Object3D | null,
    soundId: string,
    opts: Partial<AudioComponentData> = {},
  ): Promise<void> {
    const buffer = await this.load(soundId);
    if (!buffer) return;
    const priority = opts.priority ?? 0;
    if (this.live.length >= this.maxVoices) {
      let quietest = 0;
      for (let i = 1; i < this.live.length; i++) if (this.live[i]!.priority < this.live[quietest]!.priority) quietest = i;
      if (this.live[quietest]!.priority > priority) return;
      const [evicted] = this.live.splice(quietest, 1);
      if (evicted!.audio.isPlaying) evicted!.audio.stop();
      evicted!.audio.removeFromParent();
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
    const voice = { audio, priority };
    // Three binds this callback when play() creates its AudioBufferSourceNode.
    // Releasing naturally ended foley is essential: otherwise a long session
    // fills the priority budget with already-silent footsteps.
    audio.onEnded = () => {
      const index = this.live.indexOf(voice);
      if (index >= 0) this.live.splice(index, 1);
      audio.removeFromParent();
    };
    audio.play();
    this.live.push(voice);
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
    for (const { audio } of this.live) {
      try {
        if (audio.isPlaying) audio.stop();
      } catch {
        /* already ended */
      }
      audio.removeFromParent();
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
