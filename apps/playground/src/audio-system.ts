import * as THREE from "three/webgpu";

export interface AudioComponentData {
  src: string;
  volume: number;
  loop: boolean;
  autoplay: boolean;
  positional: boolean;
  refDistance: number;
}

/**
 * Play-mode audio host. The listener rides the render camera; positional
 * sources attach to entity objects. All runtime-only — stopped on ⏹.
 */
export class AudioSystem {
  private readonly listener = new THREE.AudioListener();
  private readonly buffers = new Map<string, Promise<AudioBuffer | null>>();
  private live: Array<THREE.Audio | THREE.PositionalAudio> = [];

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
    audio.setLoop(opts.loop ?? false);
    audio.play();
    this.live.push(audio);
  }

  stopAll(): void {
    for (const audio of this.live) {
      try {
        if (audio.isPlaying) audio.stop();
      } catch {
        /* already ended */
      }
      audio.removeFromParent();
    }
    this.live = [];
  }
}
