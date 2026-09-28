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
  /**
   * Playback rate for the layer clip (1 = authored). The layer keeps its own
   * rate: a cast stretched to fill its window should not also be sped up by
   * the sprint the legs are doing underneath.
   */
  speed?: number;
  /**
   * Lock the layer's playhead to the BASE clip's, offset by this many cycles
   * (0..1): every frame the layer is put at the base's normalised phase plus
   * the offset and paced to the base's rate, so a stance's upper body swings
   * in time with a different clip's legs (`stanceCarry`). `speed` is ignored
   * while locked. The offset is the caller's to measure — see
   * `carryPhaseOffset` in @hitreg/scripting.
   */
  phaseLock?: number;
}

interface Layer {
  /** Clip name as the caller asked for it (not the derived, masked clip). */
  clip: string;
  action: THREE.AnimationAction;
  additive: boolean;
  /** Playback rate asked for, kept so an idempotent re-assert can change it. */
  speed: number;
  /** Cycles ahead of the base's phase this layer is held at, or null when it runs free. */
  phaseLock: number | null;
  /** Mesh-space correction for an override layer, or null (additive, or no hip track). */
  anchor: Anchor | null;
}

/**
 * What an override layer needs to keep its torso where its clip put it.
 *
 * A masked layer hands the spine the clip's LOCAL rotations, but the hips
 * under them belong to the base. A stance clip that stands bladed — hips
 * turned 55 degrees, spine and neck twisted back so the chest, shield and
 * eyes face forward — lands that counter-twist on a walk's square hips, and
 * the whole upper body looks off to the side. So every frame the spine is
 * turned by the difference between the live hips and the clip's own: the
 * torso keeps the orientation the clip authored relative to the character
 * (a mesh-space blend), whatever the legs are doing. The turn is spread
 * over the spine chain so a big twist does not pinch at one joint.
 */
interface Anchor {
  /** The mask root's parent — the hips whose rotation the base owns. */
  hips: THREE.Object3D;
  /** The layer clip's own rotation for `hips`, sampled at the layer's playhead. */
  authored: THREE.Interpolant;
  /** Mask root and the spine bones above it that share the correction. */
  chain: THREE.Object3D[];
  /**
   * Each chain bone's rotation as the mixer left it, before the turn — put
   * back before the next mixer pass. The mixer only writes a bone whose value
   * CHANGED since its last write, so a held pose (a clamped guard) is never
   * rewritten, and a turn left in place would be turned again every frame:
   * the character spun like a rotor a second after raising a shield.
   */
  raw: THREE.Quaternion[];
  /**
   * What the turn wrote. A bone that no longer holds it was rewritten by
   * someone else since (a stopped action restoring the bind pose) and is left.
   */
  written: THREE.Quaternion[];
  /** Whether the turn is currently applied to the bones. */
  applied: boolean;
}

interface Anchored {
  anchor: Anchor;
  action: THREE.AnimationAction;
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
  /** A second base action held at a weight beside the first — see playBlend. */
  blend: { clip: string; action: THREE.AnimationAction } | null;
  animator: AnimatorData | null;
  /** Locomotion rate multiplier — applies to the base only, never the layer. */
  speedMul: number;
  /** Resolved lazily; null once we have looked and found nothing. */
  maskRoot?: string | null;
  /** Edit mode: already stood in its clip's first frame (see poseStill). */
  posedStill?: boolean;
  fading: Array<{ action: THREE.AnimationAction; until: number }>;
  /** Override layers still showing (the current one, and any fading out) and their anchors. */
  anchored: Anchored[];
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

/** How many spine bones, from the mask root up, share an anchor's turn. */
const ANCHOR_CHAIN = 3;

function findNode(root: THREE.Object3D, name: string): THREE.Object3D | null {
  const wanted = THREE.PropertyBinding.sanitizeNodeName(name);
  let found: THREE.Object3D | null = null;
  root.traverse((o) => {
    if (!found && THREE.PropertyBinding.sanitizeNodeName(o.name) === wanted) found = o;
  });
  return found;
}

/**
 * The anchor for an override layer masked at `maskRoot`, or null when the
 * clip has no rotation for the bone under the mask (nothing to keep).
 */
function layerAnchor(root: THREE.Object3D, maskRoot: string, clip: THREE.AnimationClip): Anchor | null {
  const top = findNode(root, maskRoot);
  const hips = top?.parent;
  if (!top || !hips || hips === root) return null;
  const hipsName = THREE.PropertyBinding.sanitizeNodeName(hips.name);
  const track = clip.tracks.find((t) => {
    const parsed = THREE.PropertyBinding.parseTrackName(t.name);
    return parsed.nodeName === hipsName && parsed.propertyName === "quaternion";
  });
  if (!track) return null;
  const chain = [top];
  for (let bone = top; chain.length < ANCHOR_CHAIN; ) {
    const next = bone.children.find((c) => SPINE.test(c.name));
    if (!next) break;
    chain.push(next);
    bone = next;
  }
  // untyped in @types/three, but every KeyframeTrack has it: its own interpolation mode, own buffer
  const authored = (track as unknown as { createInterpolant(): THREE.Interpolant }).createInterpolant();
  return {
    hips,
    authored,
    chain,
    raw: chain.map(() => new THREE.Quaternion()),
    written: chain.map(() => new THREE.Quaternion()),
    applied: false,
  };
}

const _authored = new THREE.Quaternion();
const _turn = new THREE.Quaternion();
const _step = new THREE.Quaternion();
const _prefix = new THREE.Quaternion();
const _prefixInv = new THREE.Quaternion();
const _local = new THREE.Quaternion();
const _identity = new THREE.Quaternion();

/** Put the chain back to the rotations the mixer left, if a turn is on it. */
function unanchor(anchor: Anchor): void {
  if (!anchor.applied) return;
  anchor.chain.forEach((bone, i) => {
    if (bone.quaternion.equals(anchor.written[i]!)) bone.quaternion.copy(anchor.raw[i]!);
  });
  anchor.applied = false;
}

/**
 * Turn the spine so the torso sits on the clip's hips instead of the live
 * ones, by `weight` (the layer's fade). With the turn C = hips⁻¹·authored
 * split into n equal steps A, bone k is premultiplied by P⁻¹·A·P, P the
 * product of the chain's local rotations below it — which composes to C
 * applied at the mask root, so the chest ends exactly where the clip had it.
 */
function applyAnchor(anchor: Anchor, time: number, weight: number): void {
  anchor.chain.forEach((bone, i) => anchor.raw[i]!.copy(bone.quaternion));
  anchor.applied = true;
  const v = anchor.authored.evaluate(time);
  _authored.set(v[0]!, v[1]!, v[2]!, v[3]!).normalize();
  _turn.copy(anchor.hips.quaternion).invert().multiply(_authored);
  _step.copy(_identity).slerp(_turn, weight / anchor.chain.length);
  _prefix.identity();
  for (const bone of anchor.chain) {
    _local.copy(bone.quaternion);
    _prefixInv.copy(_prefix).invert();
    bone.quaternion.premultiply(_prefixInv.multiply(_step).multiply(_prefix));
    _prefix.multiply(_local);
  }
  anchor.chain.forEach((bone, i) => anchor.written[i]!.copy(bone.quaternion));
}

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
      blend: null,
      animator,
      speedMul: 1,
      fading: [],
      anchored: [],
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
   * Authored length of a clip in seconds, or null when this entity has no such
   * clip (or no model yet). This is what lets a caller FIT a clip to a window
   * — stretch a one-second cast over a three-second channel — instead of
   * looping it, so it is asked for by the controller on every action start.
   */
  clipDuration(entityId: string, clip: string): number | null {
    return this.entryFor(entityId)?.clips.get(clip)?.duration ?? null;
  }

  /** Current base playback multiplier (replicated so peers match, not just guess). */
  speedOf(entityId: string): number {
    return this.entryFor(entityId)?.speedMul ?? 1;
  }

  /** Current layer playback multiplier. */
  layerSpeedOf(entityId: string): number {
    return this.entryFor(entityId)?.layer?.speed ?? 1;
  }

  /** The layer's phase lock to the base (cycles), or null when it runs free — replicated with it. */
  layerPhaseLock(entityId: string): number | null {
    return this.entryFor(entityId)?.layer?.phaseLock ?? null;
  }

  /**
   * Where the base clip's playhead is, as a fraction of the clip (0..1) —
   * read-only, for a caller that has to act IN TIME with the pose, like a
   * footstep landing when the foot does. During a held blend the heavier of
   * the two clips answers (the pair is phase-matched, so both are at the same
   * point of the stride); during a crossfade the incoming clip answers, since
   * it is the one `current` names. Null with no model or nothing playing.
   */
  baseClipPhase(entityId: string): { clip: string; t01: number } | null {
    const entry = this.entryFor(entityId);
    const base = entry?.baseAction;
    if (!entry || !base || !entry.current) return null;
    let clip = entry.current;
    let action = base;
    const blend = entry.blend;
    if (blend && blend.action.getEffectiveWeight() > base.getEffectiveWeight()) {
      clip = blend.clip;
      action = blend.action;
    }
    const duration = action.getClip().duration;
    if (!(duration > 0)) return null;
    const t01 = (((action.time / duration) % 1) + 1) % 1;
    return { clip, t01 };
  }

  /**
   * Crossfade to a clip (fade seconds). The core blending primitive.
   * `loop: false` plays the clip once, holds the final pose, and raises the
   * mixer's "finished" event → {@link onClipFinished} (drives
   * "animation.completed"); the default loops forever and never finishes.
   *
   * `sync` carries the outgoing clip's PHASE into the new one (normalised
   * time, so a 1.1 s walk and a 0.7 s run land on the same step). That is
   * what a gait change wants: a walk→run crossfade that restarts the run at
   * frame 0 swaps the feet mid-stride, a visible pop at every threshold.
   */
  play(entityId: string, clip: string, fade = 0.3, loop = true, restart = false, sync = false): void {
    const entry = this.entryFor(entityId);
    if (!entry) return;
    // asking for one clip ends a held blend (see playBlend)
    if (entry.blend) {
      this.fadeOut(entry, entry.blend.action, fade);
      entry.blend = null;
      if (entry.baseAction) entry.baseAction.weight = 1;
    }
    if (!entry.actions.has(clip)) {
      console.warn(
        `[anim] ${entityId}: no clip "${clip}" (has: ${[...entry.actions.keys()].join(", ")})`,
      );
      return;
    }
    // Idempotent by default — callers re-assert the clip every tick. `restart`
    // is how a one-shot plays a SECOND time: a clip that ran to its end and
    // clamped there is still "current", so without this the second cast of a
    // spell holds the pose from the first.
    if (entry.current === clip && !restart) return;
    entry.current = clip;
    entry.baseLoop = loop;
    this.applyBase(entry, fade, sync && !restart, restart);
  }

  /**
   * Hold TWO base clips at once, `from` at `1 - weight` and `to` at
   * `weight`, phase-matched so their strides land together.
   *
   * A crossfade is a blend that always finishes. This one is a blend that
   * STAYS, which is what a continuous quantity needs: a character wading into
   * a lake should take on the wade a little at a time as the water climbs, not
   * cross a line and duck. The caller ramps `weight` and the pose follows it.
   *
   * The ends are not special-cased by the caller: weight 0 or 1 falls through
   * to a plain {@link play} of the clip that won, so a blend can be asked for
   * every tick and simply stops existing when it is no longer a blend.
   *
   * A masked override layer is the one case this declines — that path builds
   * the base's complement from ONE clip, and two complements is a great deal
   * of machinery for a cast played while wading. The dominant clip takes it,
   * which is what a crossfade would have given anyway.
   */
  playBlend(entityId: string, from: string, to: string, weight: number, fade = 0.25): void {
    const entry = this.entryFor(entityId);
    if (!entry) return;
    const w = Math.max(0, Math.min(1, weight));
    const over = entry.clips.has(to) ? entry.actions.get(to) : undefined;
    if (!over || from === to || (entry.layer && !entry.layer.additive)) {
      this.play(entityId, w >= 0.5 && over ? to : from, fade);
      return;
    }
    if (w <= 0.001) return this.play(entityId, from, fade);
    if (w >= 0.999) return this.play(entityId, to, fade);
    // the base half goes through the ordinary path, so `current`, the
    // finished-event origin map and the fade bookkeeping stay exactly as they
    // are for a single clip
    if (entry.current !== from) {
      entry.current = from;
      entry.baseLoop = true;
      this.applyBase(entry, fade, true);
    }
    const base = entry.baseAction;
    if (!base || base === over) return;
    if (entry.blend && entry.blend.action !== over) {
      this.fadeOut(entry, entry.blend.action, fade);
      entry.blend = null;
    }
    if (!entry.blend) {
      over.enabled = true;
      over.paused = false;
      over.setLoop(THREE.LoopRepeat, Infinity);
      over.clampWhenFinished = false;
      over.stopFading();
      over.play();
      entry.blend = { clip: to, action: over };
    }
    over.timeScale = base.timeScale;
    // Phase-matched: two cycles at their own phases read as two characters
    // wearing one body. Matched, a half-and-half mix is one gait.
    const baseDuration = base.getClip().duration;
    const overDuration = over.getClip().duration;
    if (baseDuration > 0 && overDuration > 0) over.time = (base.time / baseDuration) * overDuration;
    base.stopFading();
    over.stopFading();
    base.weight = 1 - w;
    over.weight = w;
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
    const speed = opts.speed ?? 1;
    const phaseLock = typeof opts.phaseLock === "number" && Number.isFinite(opts.phaseLock) ? opts.phaseLock : null;
    // Idempotent, like play(): net replication re-asserts the layer every
    // frame it is up, and restarting the clip each time would freeze it on
    // its first frame. `restart` is how a caller replays the same clip.
    if (!opts.restart && entry.layer?.clip === clip && entry.layer.additive === additive) {
      // …but a re-assert MAY retune the rate. A cast whose window is extended
      // mid-flight (a channel that got longer) slows down where it stands
      // rather than starting over.
      // …and re-aim a lock: the legs under the same upper-body clip may have
      // changed (walk → run, or a new offset). A lock let go runs free at the
      // asked rate from where it stands.
      const unlocked = entry.layer.phaseLock !== null && phaseLock === null;
      entry.layer.phaseLock = phaseLock;
      if (speed !== entry.layer.speed || unlocked) {
        entry.layer.speed = speed;
        if (phaseLock === null) entry.layer.action.timeScale = speed;
      }
      return;
    }
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
    const anchor = additive || !maskRoot ? null : layerAnchor(entry.root, maskRoot, source);
    entry.layer = { clip, action, additive, speed, phaseLock, anchor };
    // Keyed by action: a layer replayed over itself keeps one entry, and a
    // replaced one keeps its own while it fades out underneath.
    if (anchor && !entry.anchored.some((a) => a.action === action)) entry.anchored.push({ anchor, action });
    // The base moves off the full-body clip FIRST for an override layer,
    // otherwise both drive the masked bones and the mixer averages them.
    if (!additive) this.applyBase(entry, fade, true);
    if (previous && previous.action !== action) this.fadeOut(entry, previous.action, fade);
    this.transition(entry, action, null, fade, {
      loop,
      weight: opts.weight ?? 1,
      timeScale: speed,
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
  private applyBase(entry: Entry, fade: number, syncTime: boolean, restart = false): void {
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
      restart,
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
   * — a fresh action starts at frame 0, which pops the legs mid-stride — and
   * between two gait cycles (see play's `sync`). `from` keeps the timeScale it
   * had: the caller sets the new clip's rate AFTER this, so the outgoing cycle
   * fades out at its own pace instead of the incoming one's.
   */
  private transition(
    entry: Entry,
    next: THREE.AnimationAction,
    from: THREE.AnimationAction | null,
    fade: number,
    opts: { loop: boolean; weight?: number; timeScale?: number; syncTime?: boolean; restart?: boolean },
  ): void {
    if (next === from) {
      // Same action, played again (a repeated one-shot): rewind it in place.
      // Crossfading an action with itself would ramp its own weight from zero
      // and drop the pose on the floor for the length of the fade.
      if (!opts.restart) return;
      next.stopFading();
      next.enabled = true;
      next.paused = false;
      next.weight = opts.weight ?? 1;
      next.setLoop(opts.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
      next.clampWhenFinished = !opts.loop;
      next.timeScale = opts.timeScale ?? 1;
      next.time = 0;
      next.play();
      return;
    }
    next.enabled = true;
    next.paused = false;
    next.setLoop(opts.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    next.clampWhenFinished = !opts.loop; // one-shots hold their last frame
    next.timeScale = opts.timeScale ?? 1;
    // Synced by PHASE, not seconds: the same clip under a different mask has
    // the same length either way, and two different gait cycles only line up
    // their steps as fractions of their own cycle.
    const duration = next.getClip().duration;
    const fromDuration = from ? from.getClip().duration : 0;
    const phase = opts.syncTime && from && from !== next && fromDuration > 0 ? from.time / fromDuration : 0;
    next.time = duration > 0 ? (opts.loop ? phase % 1 : Math.min(1, phase)) * duration : 0;
    next.weight = opts.weight ?? 1;
    next.stopFading();
    next.play();
    if (fade > 0) {
      next.fadeIn(fade);
      if (from && from !== next) this.fadeOut(entry, from, fade);
    } else if (from !== next) from?.stop();
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

  /**
   * EDIT mode: stand each animated model in the FIRST FRAME of its declared
   * clip instead of its bind pose. An auto-rigged bind pose is a steep A-pose
   * nobody animates in, and it is what the editor showed — so a sword placed
   * in the hand there was placed in a pose the character never takes. One
   * evaluation per model (the bones keep it once the action stops), so this
   * is free to call every frame; a model that loads later is posed when it
   * arrives. No-op while running.
   */
  poseStill(): void {
    if (this.running) return;
    for (const entry of this.entries.values()) {
      if (entry.posedStill) continue;
      entry.posedStill = true;
      const clip = entry.animator?.play;
      const action = clip ? entry.actions.get(clip) : undefined;
      if (!action) continue;
      action.reset().play();
      entry.mixer.update(0);
      action.stop();
    }
  }

  /** Play mode started: run every animator's declared clip. */
  setRunning(running: boolean): void {
    this.running = running;
    for (const entry of this.entries.values()) entry.posedStill = false;
    for (const [id, entry] of this.entries) {
      if (running) {
        if (entry.animator?.play) this.play(id, entry.animator.play, 0);
      } else {
        entry.mixer.stopAllAction();
        entry.current = null;
        entry.baseAction = null;
        entry.layer = null;
        entry.fading.length = 0;
        entry.anchored.length = 0;
      }
    }
  }

  update(dt: number): void {
    if (!this.running) return;
    for (const entry of this.entries.values()) {
      if (entry.layer && entry.layer.phaseLock !== null) this.lockLayer(entry, entry.layer);
      // Undo last frame's turns (newest first, they stack) so the mixer and
      // the anchors both start from the clip's own pose.
      for (let i = entry.anchored.length - 1; i >= 0; i--) unanchor(entry.anchored[i]!.anchor);
      entry.mixer.update(dt);
      if (entry.anchored.length > 0) this.anchorLayers(entry);
      entry.clock += dt;
      if (entry.fading.length > 0) this.reapFaded(entry);
    }
  }

  /**
   * Put a phase-locked layer where the base's stride says it should be, and
   * pace it to cover one cycle per base cycle. Done BEFORE the mixer advances:
   * both then move by the same fraction of their own cycles this frame, so the
   * pose applied is in step rather than one frame behind. The heavier clip of
   * a held blend is the one the layer follows, as for baseClipPhase.
   */
  private lockLayer(entry: Entry, layer: Layer): void {
    let base = entry.baseAction;
    if (!base) return;
    const blend = entry.blend;
    if (blend && blend.action.getEffectiveWeight() > base.getEffectiveWeight()) base = blend.action;
    const baseDuration = base.getClip().duration;
    const duration = layer.action.getClip().duration;
    if (!(baseDuration > 0) || !(duration > 0)) return;
    const phase = base.time / baseDuration + (layer.phaseLock ?? 0);
    layer.action.time = (((phase % 1) + 1) % 1) * duration;
    layer.action.timeScale = base.timeScale * (duration / baseDuration);
  }

  /**
   * Re-seat the torso of every override layer still showing (see Anchor),
   * right after the mixer wrote the pose. A layer fading out keeps its anchor
   * at its fading weight, so dropping a guard mid-walk eases the chest back
   * onto the gait's hips instead of snapping it there.
   */
  private anchorLayers(entry: Entry): void {
    entry.anchored = entry.anchored.filter(({ anchor, action }) => {
      const weight = action.isScheduled() ? action.getEffectiveWeight() : 0;
      if (weight <= 0) return action === entry.layer?.action;
      applyAnchor(anchor, action.time, Math.min(1, weight));
      return true;
    });
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
