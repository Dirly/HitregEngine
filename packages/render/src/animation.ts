import * as THREE from "three/webgpu";

export interface AnimatorData {
  play?: string;
  fade: number;
  speed: number;
  /**
   * Bone the upper-body layer masks from. Absent means "work it out": the
   * shallowest spine/waist/chest bone in the skeleton, which is where every
   * rig this engine retargets puts the split.
   */
  upperBody?: string;
}

/** How a layer sits on top of the base clip. */
export interface LayerOptions {
  /** Crossfade seconds into the layer (and, on stop, back out of it). */
  fade?: number;
  /** Loop the layer clip. One-shots hold their last pose until cleared. */
  loop?: boolean;
  /** 0..1 — how much of the layer to apply. Only meaningful for additive. */
  weight?: number;
  /** Bone to mask from; defaults to the animator's `upperBody`/auto-detect. */
  mask?: string;
  /** Add onto the base pose (aim offsets, leans) instead of replacing it. */
  additive?: boolean;
  /** Replay from frame 0 even if this clip is already the layer. */
  restart?: boolean;
}

interface Layer {
  /** Clip name as the caller asked for it (not the derived, masked clip). */
  clip: string;
  action: THREE.AnimationAction;
  additive: boolean;
}

interface Entry {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  clips: Map<string, THREE.AnimationClip>;
  /** Full-body action per clip — the plain, unmasked case. */
  actions: Map<string, THREE.AnimationAction>;
  /** Derived (masked / additive) actions, keyed by clip + what was done to it. */
  variants: Map<string, THREE.AnimationAction>;
  /** Derived clip -> the name the caller knows it by, for the finished event. */
  origin: Map<THREE.AnimationClip, string>;
  /** Base clip name as requested; the action driving it may be a masked variant. */
  current: string | null;
  baseAction: THREE.AnimationAction | null;
  baseLoop: boolean;
  layer: Layer | null;
  animator: AnimatorData | null;
  /** Locomotion rate multiplier — applies to the base only, never the layer. */
  speedMul: number;
  /** Resolved lazily; null once we have looked and found nothing. */
  maskRoot?: string | null;
  fading: Array<{ action: THREE.AnimationAction; until: number }>;
  clock: number;
}

/** Node name a track drives ("" for tracks bound to the root itself). */
function trackNode(track: THREE.KeyframeTrack): string {
  return THREE.PropertyBinding.parseTrackName(track.name).nodeName ?? "";
}

/**
 * The clip's tracks restricted to (or excluding) a set of node names. Tracks
 * bound to nothing in particular — the root's own position, a morph target —
 * always stay with the base: they are the character, not a limb.
 */
function maskClip(
  clip: THREE.AnimationClip,
  nodes: Set<string>,
  keep: boolean,
  suffix: string,
): THREE.AnimationClip {
  const tracks = clip.tracks.filter((t) => {
    const node = trackNode(t);
    return node !== "" && nodes.has(node) === keep;
  });
  const out = new THREE.AnimationClip(`${clip.name}${suffix}`, clip.duration, tracks);
  out.blendMode = clip.blendMode;
  return out;
}

/** Every node at or under `name`, by name. Null when the bone is not there. */
function subtreeNames(root: THREE.Object3D, name: string): Set<string> | null {
  const wanted = THREE.PropertyBinding.sanitizeNodeName(name);
  let found: THREE.Object3D | null = null;
  root.traverse((o) => {
    if (found) return;
    if (THREE.PropertyBinding.sanitizeNodeName(o.name) === wanted) found = o;
  });
  if (!found) return null;
  const names = new Set<string>();
  (found as THREE.Object3D).traverse((o) => {
    if (o.name) names.add(THREE.PropertyBinding.sanitizeNodeName(o.name));
  });
  return names;
}

const SPINE = /(spine|waist|chest|torso|abdomen)/i;

/**
 * Where to split a humanoid when nobody said. The SHALLOWEST spine-ish bone is
 * the first joint above the hips, which is the split every game uses for an
 * upper-body layer: the legs keep their gait, everything from the waist up
 * belongs to the action.
 */
function autoMaskRoot(root: THREE.Object3D): string | null {
  // breadth-first, so the first match IS the shallowest one
  let level: THREE.Object3D[] = [root];
  while (level.length > 0) {
    const next: THREE.Object3D[] = [];
    for (const o of level) {
      if (o.name && SPINE.test(o.name)) return o.name;
      next.push(...o.children);
    }
    level = next;
  }
  return null;
}

/**
 * Skeletal animation host with Unity-style crossfade blending. Entities
 * register as their glTF models finish loading; play mode starts each
 * animator's declared clip; scripts blend via play().
 *
 * On top of that one base clip sits an optional LAYER — a clip masked to a
 * bone subtree, so a character can cast or swing while its legs keep running.
 * In override mode the base is re-played masked to the complement of what the
 * layer drives, so each bone has exactly one driver: three's mixer averages
 * everything that touches a binding, and two full-body actions at weight 1
 * would give a half-cast, half-run pose rather than a layered one. Additive
 * layers (aim offsets, hit reactions, leans) accumulate separately and leave
 * the base alone.
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
    const entry: Entry = {
      root,
      mixer,
      clips: new Map(clips.map((c) => [c.name, c])),
      actions,
      variants: new Map(),
      origin: new Map(),
      current: null,
      baseAction: null,
      baseLoop: true,
      layer: null,
      animator,
      speedMul: 1,
      fading: [],
      clock: 0,
    };
    // LoopOnce actions raise "finished" here; LoopRepeat ones never do. A
    // masked variant reports the name the caller knows, not the derived one.
    mixer.addEventListener("finished", (event) => {
      const clip = (event as unknown as { action: THREE.AnimationAction }).action.getClip();
      this.onClipFinished?.(entityId, entry.origin.get(clip) ?? clip.name);
    });
    this.entries.set(entityId, entry);
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

  /** The clips an entity's model shipped with (via its delegate child) — for a second mixer, e.g. a portrait. */
  clipsOf(entityId: string): THREE.AnimationClip[] {
    return [...(this.entryFor(entityId)?.clips.values() ?? [])];
  }

  /** The clip currently playing (net replication reads this per tick). */
  currentClip(entityId: string): string | null {
    return this.entryFor(entityId)?.current ?? null;
  }

  /** The layer clip playing over the base, if any (replicated alongside it). */
  layerClip(entityId: string): string | null {
    return this.entryFor(entityId)?.layer?.clip ?? null;
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
    if (!entry.actions.has(clip)) {
      console.warn(
        `[anim] ${entityId}: no clip "${clip}" (has: ${[...entry.actions.keys()].join(", ")})`,
      );
      return;
    }
    if (entry.current === clip) return;
    entry.current = clip;
    entry.baseLoop = loop;
    this.applyBase(entry, fade, false);
  }

  /**
   * Play `clip` on a masked layer over whatever the base is doing — the
   * "run and cast" case. Override (the default) replaces the base on the
   * masked bones; `additive` adds the clip's motion on top of it.
   *
   * A rig with no matching mask bone falls back to a plain full-body play
   * rather than dropping the action on the floor: better a cast that stops
   * the legs than a cast nobody sees.
   */
  playLayer(entityId: string, clip: string, opts: LayerOptions = {}): void {
    const entry = this.entryFor(entityId);
    if (!entry) return;
    const source = entry.clips.get(clip);
    if (!source) {
      console.warn(
        `[anim] ${entityId}: no clip "${clip}" (has: ${[...entry.clips.keys()].join(", ")})`,
      );
      return;
    }
    const fade = opts.fade ?? entry.animator?.fade ?? 0.2;
    const loop = opts.loop ?? false;
    const additive = opts.additive === true;
    // Idempotent, like play(): net replication re-asserts the layer every
    // frame it is up, and restarting the clip each time would freeze it on
    // its first frame. `restart` is how a caller replays the same clip.
    if (!opts.restart && entry.layer?.clip === clip && entry.layer.additive === additive) return;
    const maskRoot = opts.mask ?? this.maskRootOf(entry);
    const nodes = maskRoot ? subtreeNames(entry.root, maskRoot) : null;
    if (!nodes || nodes.size === 0) {
      console.warn(
        `[anim] ${entityId}: no mask bone ${maskRoot ? `"${maskRoot}"` : "(none matched)"} — ` +
          `playing "${clip}" full-body instead`,
      );
      this.play(entityId, clip, fade, loop);
      return;
    }

    const key = `${clip}|${additive ? "add" : "up"}:${maskRoot}`;
    let action = entry.variants.get(key);
    if (!action) {
      let masked = maskClip(source, nodes, true, additive ? " (add)" : " (upper)");
      if (masked.tracks.length === 0) {
        console.warn(`[anim] ${entityId}: "${clip}" drives nothing under "${maskRoot}"`);
        this.play(entityId, clip, fade, loop);
        return;
      }
      if (additive) {
        // makeClipAdditive mutates, so it only ever sees our own copy. The
        // reference pose is the clip's own first frame, which is what makes a
        // library's aim/lean clips add to the base rather than replace it.
        masked = THREE.AnimationUtils.makeClipAdditive(masked);
      }
      entry.origin.set(masked, clip);
      action = entry.mixer.clipAction(
        masked,
        undefined,
        additive ? THREE.AdditiveAnimationBlendMode : THREE.NormalAnimationBlendMode,
      );
      entry.variants.set(key, action);
    }

    const previous = entry.layer;
    entry.layer = { clip, action, additive };
    // The base moves off the full-body clip FIRST for an override layer,
    // otherwise both drive the masked bones and the mixer averages them.
    if (!additive) this.applyBase(entry, fade, true);
    if (previous && previous.action !== action) this.fadeOut(entry, previous.action, fade);
    this.transition(entry, action, null, fade, {
      loop,
      weight: opts.weight ?? 1,
      timeScale: 1,
    });
  }

  /** Fade the layer out and give the base its whole body back. */
  clearLayer(entityId: string, fade = 0.2): void {
    const entry = this.entryFor(entityId);
    if (!entry?.layer) return;
    const layer = entry.layer;
    entry.layer = null;
    this.fadeOut(entry, layer.action, fade);
    if (!layer.additive) this.applyBase(entry, fade, true);
  }

  /**
   * Put the base clip on the right action: the full body normally, masked to
   * the complement of the layer while an override layer is up. Called on every
   * gait change and every layer change, so the two never fight over a bone.
   */
  private applyBase(entry: Entry, fade: number, syncTime: boolean): void {
    if (!entry.current) return;
    const clip = entry.clips.get(entry.current);
    if (!clip) return;
    const layer = entry.layer;
    let action = entry.actions.get(entry.current)!;
    if (layer && !layer.additive) {
      const driven = new Set(layer.action.getClip().tracks.map(trackNode));
      const key = `${entry.current}|not:${layer.action.getClip().name}`;
      let variant = entry.variants.get(key);
      if (!variant) {
        // The complement is measured against what the LAYER actually drives,
        // not against the mask: a bone the mask covers but the layer clip has
        // no track for would otherwise have no driver at all and freeze.
        const masked = maskClip(clip, driven, false, " (base)");
        entry.origin.set(masked, entry.current);
        variant = entry.mixer.clipAction(masked);
        entry.variants.set(key, variant);
      }
      action = variant;
    }
    this.transition(entry, action, entry.baseAction, fade, {
      loop: entry.baseLoop,
      timeScale: entry.speedMul,
      syncTime,
    });
    entry.baseAction = action;
  }

  /** The bone an upper-body layer masks from, resolved once per model. */
  private maskRootOf(entry: Entry): string | null {
    if (entry.maskRoot === undefined) {
      entry.maskRoot = entry.animator?.upperBody || autoMaskRoot(entry.root);
    }
    return entry.maskRoot;
  }

  /**
   * Start `next`, optionally picking up `from`'s playhead, and fade `from`
   * out. Time sync matters when the two are the same clip in different masks
   * — a fresh action starts at frame 0, which pops the legs mid-stride.
   */
  private transition(
    entry: Entry,
    next: THREE.AnimationAction,
    from: THREE.AnimationAction | null,
    fade: number,
    opts: { loop: boolean; weight?: number; timeScale?: number; syncTime?: boolean },
  ): void {
    if (next === from) return;
    next.enabled = true;
    next.paused = false;
    next.setLoop(opts.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    next.clampWhenFinished = !opts.loop; // one-shots hold their last frame
    next.timeScale = opts.timeScale ?? 1;
    const duration = next.getClip().duration;
    next.time = opts.syncTime && from && duration > 0 ? from.time % duration : 0;
    next.weight = opts.weight ?? 1;
    next.stopFading();
    next.play();
    if (fade > 0) {
      next.fadeIn(fade);
      if (from) this.fadeOut(entry, from, fade);
    } else from?.stop();
  }

  /** Fade an action out and stop it once it has actually reached zero. */
  private fadeOut(entry: Entry, action: THREE.AnimationAction, fade: number): void {
    if (fade <= 0) {
      action.stop();
      return;
    }
    action.stopFading();
    action.fadeOut(fade);
    entry.fading.push({ action, until: entry.clock + fade });
  }

  /**
   * Scale playback rate on top of the animator's authored `speed`. This is
   * what keeps a locomotion clip's feet planted: an in-place walk cycle is
   * authored for one ground speed, so a character moving faster than that
   * skates unless the clip plays proportionally faster. Applied to the BASE
   * action alone — a cast layered over a sprint should not itself play at
   * sprint rate. Runtime-only, like every other channel here.
   */
  setSpeed(entityId: string, multiplier: number): void {
    const entry = this.entryFor(entityId);
    if (!entry) return;
    entry.speedMul = multiplier;
    if (entry.baseAction) entry.baseAction.timeScale = multiplier;
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
        entry.baseAction = null;
        entry.layer = null;
        entry.fading.length = 0;
      }
    }
  }

  update(dt: number): void {
    if (!this.running) return;
    for (const entry of this.entries.values()) {
      entry.mixer.update(dt);
      entry.clock += dt;
      if (entry.fading.length > 0) this.reapFaded(entry);
    }
  }

  /**
   * Stop actions that have finished fading out. Left running they are nearly
   * free (a zero-weight action skips accumulation) but they keep advancing
   * their playhead, so a clip resumed later would come back mid-stride.
   */
  private reapFaded(entry: Entry): void {
    entry.fading = entry.fading.filter(({ action, until }) => {
      if (entry.clock < until) return true;
      if (action !== entry.baseAction && action !== entry.layer?.action) action.stop();
      return false;
    });
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
