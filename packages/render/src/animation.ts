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
  /** Parent entity id -> the child entity whose model answers for it. */
  private readonly delegates = new Map<string, string>();
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
    parentEntityId?: string | null,
  ): void {
    if (clips.length === 0) return;
    // A character is a physics body with its model on a CHILD entity — the
    // body's rotation belongs to the sim, so the visual has to be separately
    // steerable. Scripts live on the body and address animation by their own
    // id, so the child registers itself as the body's stand-in. First model
    // under a parent wins; a second one does not displace it.
    if (parentEntityId && !this.delegates.has(parentEntityId)) {
      this.delegates.set(parentEntityId, entityId);
    }
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

  /**
   * The entry that answers for an entity: its own model, else the model on the
   * child it registered through. Everything public here goes via this, so a
   * script on a physics body and an animator on that body's visual child are
   * the same thing from the outside.
   */
  private entryFor(entityId: string): Entry | undefined {
    const own = this.entries.get(entityId);
    if (own) return own;
    const delegate = this.delegates.get(entityId);
    return delegate ? this.entries.get(delegate) : undefined;
  }

  clipNames(entityId: string): string[] {
    return [...(this.entryFor(entityId)?.actions.keys() ?? [])];
  }

  /** The clip currently playing (net replication reads this per tick). */
  currentClip(entityId: string): string | null {
    return this.entryFor(entityId)?.current ?? null;
  }

  /**
   * Crossfade to a clip (fade seconds). The core blending primitive.
   * `loop: false` plays the clip once, holds the final pose, and raises the
   * mixer's "finished" event → {@link onClipFinished} (drives
   * "animation.completed"); the default loops forever and never finishes.
   */
  play(entityId: string, clip: string, fade = 0.3, loop = true): void {
    const entry = this.entryFor(entityId);
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

  /**
   * Scale playback rate on top of the animator's authored `speed`. This is
   * what keeps a locomotion clip's feet planted: an in-place walk cycle is
   * authored for one ground speed, so a character moving faster than that
   * skates unless the clip plays proportionally faster. Runtime-only, like
   * every other channel here — the animator component never changes.
   */
  setSpeed(entityId: string, multiplier: number): void {
    const entry = this.entryFor(entityId);
    if (!entry) return;
    entry.mixer.timeScale = (entry.animator?.speed ?? 1) * multiplier;
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
    for (const [parent, child] of this.delegates) {
      if (child === entityId) this.delegates.delete(parent);
    }
  }

  clear(): void {
    this.entries.clear();
    this.delegates.clear();
  }
}
