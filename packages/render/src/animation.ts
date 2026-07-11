import * as THREE from "three/webgpu";

export interface AnimatorData {
  play?: string;
  fade: number;
  speed: number;
}

interface Entry {
  mixer: THREE.AnimationMixer;
  actions: Map<string, THREE.AnimationAction>;
  current: string | null;
  animator: AnimatorData | null;
}

/**
 * Skeletal animation host with Unity-style crossfade blending. Entities
 * register as their glTF models finish loading; play mode starts each
 * animator's declared clip; scripts blend via play(). Runtime-only state —
 * the document never changes.
 */
export class AnimationSystem {
  private readonly entries = new Map<string, Entry>();
  private running = false;

  /**
   * Fired when a one-shot clip (played with `loop: false`) reaches its end.
   * The playground wires this to the session bus's "animation.completed"
   * event — a LOCAL signal (each client's mixer runs on its own render
   * clock; remote entities are ghosted), so it never crosses the network.
   */
  onClipFinished?: (entityId: string, clip: string) => void;

  register(
    entityId: string,
    root: THREE.Object3D,
    clips: THREE.AnimationClip[],
    animator: AnimatorData | null,
  ): void {
    if (clips.length === 0) return;
    const mixer = new THREE.AnimationMixer(root);
    const actions = new Map(clips.map((clip) => [clip.name, mixer.clipAction(clip)]));
    mixer.timeScale = animator?.speed ?? 1;
    // LoopOnce actions raise "finished" here; LoopRepeat ones never do
    mixer.addEventListener("finished", (event) => {
      const clip = (event as unknown as { action: THREE.AnimationAction }).action.getClip();
      this.onClipFinished?.(entityId, clip.name);
    });
    this.entries.set(entityId, { mixer, actions, current: null, animator });
    // model loaded mid-play: start its declared clip immediately
    if (this.running && animator?.play) this.play(entityId, animator.play, 0);
  }

  clipNames(entityId: string): string[] {
    return [...(this.entries.get(entityId)?.actions.keys() ?? [])];
  }

  /** The clip currently playing (net replication reads this per tick). */
  currentClip(entityId: string): string | null {
    return this.entries.get(entityId)?.current ?? null;
  }

  /**
   * Crossfade to a clip (fade seconds). The core blending primitive.
   * `loop: false` plays the clip once, holds the final pose, and raises the
   * mixer's "finished" event → {@link onClipFinished} (drives
   * "animation.completed"); the default loops forever and never finishes.
   */
  play(entityId: string, clip: string, fade = 0.3, loop = true): void {
    const entry = this.entries.get(entityId);
    if (!entry) return;
    const next = entry.actions.get(clip);
    if (!next) {
      console.warn(
        `[anim] ${entityId}: no clip "${clip}" (has: ${[...entry.actions.keys()].join(", ")})`,
      );
      return;
    }
    const prev = entry.current ? entry.actions.get(entry.current) : undefined;
    if (prev === next) return;
    next.reset();
    next.enabled = true;
    // set the loop mode every play — actions are reused across looped/one-shot calls
    next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    next.clampWhenFinished = !loop; // one-shots hold their last frame
    next.play();
    if (prev && fade > 0) next.crossFadeFrom(prev, fade, true);
    else prev?.stop();
    entry.current = clip;
  }

  /** Play mode started: run every animator's declared clip. */
  setRunning(running: boolean): void {
    this.running = running;
    for (const [id, entry] of this.entries) {
      if (running) {
        if (entry.animator?.play) this.play(id, entry.animator.play, 0);
      } else {
        entry.mixer.stopAllAction();
        entry.current = null;
      }
    }
  }

  update(dt: number): void {
    if (!this.running) return;
    for (const entry of this.entries.values()) entry.mixer.update(dt);
  }

  /** Drop one entity's mixer (its visuals were rebuilt or removed). */
  unregister(entityId: string): void {
    this.entries.get(entityId)?.mixer.stopAllAction();
    this.entries.delete(entityId);
  }

  clear(): void {
    this.entries.clear();
  }
}
